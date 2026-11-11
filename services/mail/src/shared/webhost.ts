// A company's own web address for Mac Tidar Mail (mail.<their domain>). Each one is a tenant of
// one shared CloudFront multi-tenant distribution in front of the web app. The company points a
// CNAME at our routing endpoint; CloudFront then gets and renews the HTTPS certificate itself
// (HTTP validation through that CNAME), so there's nothing else for them to add.
import {
  CloudFrontClient, CreateDistributionTenantCommand, DeleteDistributionTenantCommand, GetDistributionTenantCommand,
  GetManagedCertificateDetailsCommand, UpdateDistributionTenantCommand,
} from "@aws-sdk/client-cloudfront";

export const webHostName = (domain: string) => `mail.${domain}`;

export type WebHostStatus = "pending" | "active";
/** Stored on a verified domain once its owner asks for mail.<domain>. */
export interface WebHost {
  host: string; tenantId: string; status: WebHostStatus;
  /** The company's CNAME points at our routing endpoint (checked on their own nameservers). */
  dns: boolean;
  /** CloudFront's managed certificate: "pending-validation", "issued", … */
  certificate: string | null;
  createdAt: string; checkedAt?: string;
}

export interface WebHosts {
  /** Where the company's `mail` CNAME must point. */
  routingEndpoint: string;
  create(host: string, domain: string): Promise<{ tenantId: string }>;
  /**
   * Whether CloudFront serves the host yet, and the certificate's state. Once the managed
   * certificate is issued it must be attached to the tenant (CloudFront doesn't do that itself);
   * this does it, and the host goes active once CloudFront has deployed that.
   */
  status(tenantId: string): Promise<{ active: boolean; certificate: string | null; attached: boolean }>;
  /** Stops serving the host. A disabled tenant can be deleted once CloudFront has deployed that. */
  disable(tenantId: string): Promise<void>;
  /** Deletes a disabled tenant; false while CloudFront is still deploying the change. */
  remove(tenantId: string): Promise<boolean>;
}

/** Tenant names: letters, digits and hyphens, unique per account. */
const tenantName = (domain: string) => `mail-${domain.replace(/[^a-z0-9-]/gi, "-")}`.slice(0, 128);

export function cloudFrontWebHosts(cf: CloudFrontClient, p: { distributionId: string; connectionGroupId: string; routingEndpoint: string }): WebHosts {
  return {
    routingEndpoint: p.routingEndpoint,
    async create(host, domain) {
      const r = await cf.send(new CreateDistributionTenantCommand({
        DistributionId: p.distributionId, ConnectionGroupId: p.connectionGroupId, Name: tenantName(domain), Enabled: true,
        Domains: [{ Domain: host }],
        ManagedCertificateRequest: { ValidationTokenHost: "cloudfront", PrimaryDomainName: host, CertificateTransparencyLoggingPreference: "enabled" },
      }));
      return { tenantId: r.DistributionTenant!.Id! };
    },
    async status(tenantId) {
      const [t, cert] = await Promise.all([
        cf.send(new GetDistributionTenantCommand({ Identifier: tenantId })),
        cf.send(new GetManagedCertificateDetailsCommand({ Identifier: tenantId })).catch(() => null),
      ]);
      const d = t.DistributionTenant!;
      const active = (d.Domains ?? []).some(x => x.Status === "active");
      const certificate = cert?.ManagedCertificateDetails?.CertificateStatus ?? null, arn = cert?.ManagedCertificateDetails?.CertificateArn;
      let attached = !!arn && d.Customizations?.Certificate?.Arn === arn;
      if (certificate === "issued" && arn && !attached) {
        // The last step of the setup: use the issued certificate for the tenant's domain.
        await cf.send(new UpdateDistributionTenantCommand({ Id: tenantId, IfMatch: t.ETag, DistributionId: d.DistributionId, ConnectionGroupId: d.ConnectionGroupId, Enabled: d.Enabled,
          Domains: d.Domains?.map(x => ({ Domain: x.Domain! })), Customizations: { ...d.Customizations, Certificate: { Arn: arn } } }));
        attached = true;
      }
      return { active, certificate, attached };
    },
    async disable(tenantId) {
      const t = await cf.send(new GetDistributionTenantCommand({ Identifier: tenantId }));
      const d = t.DistributionTenant!;
      if (d.Enabled === false) return;
      await cf.send(new UpdateDistributionTenantCommand({ Id: tenantId, IfMatch: t.ETag, Enabled: false, DistributionId: d.DistributionId, Domains: d.Domains?.map(x => ({ Domain: x.Domain! })), ConnectionGroupId: d.ConnectionGroupId }));
    },
    async remove(tenantId) {
      const t = await cf.send(new GetDistributionTenantCommand({ Identifier: tenantId })).catch(e => { if ((e as Error).name === "EntityNotFound") return null; throw e; });
      if (!t) return true;
      if (t.DistributionTenant?.Enabled !== false || t.DistributionTenant?.Status !== "Deployed") return false;
      await cf.send(new DeleteDistributionTenantCommand({ Id: tenantId, IfMatch: t.ETag }));
      return true;
    },
  };
}
