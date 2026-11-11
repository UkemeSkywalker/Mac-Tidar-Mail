// The CloudFront side of a company's web address: once the managed certificate is issued, it has to
// be attached to the tenant, or the domain stays inactive (CloudFront answers 403).
import { CloudFrontClient, GetDistributionTenantCommand, type GetDistributionTenantCommandOutput, GetManagedCertificateDetailsCommand, UpdateDistributionTenantCommand } from "@aws-sdk/client-cloudfront";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { cloudFrontWebHosts } from "../../src/shared/webhost";

const cf = mockClient(CloudFrontClient);
beforeEach(() => cf.reset());
const hosts = () => cloudFrontWebHosts(new CloudFrontClient({ region: "us-east-1" }), { distributionId: "E1", connectionGroupId: "cg_1", routingEndpoint: "d1.cloudfront.net" });
const tenant = (over: Record<string, unknown> = {}): GetDistributionTenantCommandOutput => ({ $metadata: {}, ETag: "etag-1", DistributionTenant: { Id: "dt_1", DistributionId: "E1", ConnectionGroupId: "cg_1", Enabled: true, Domains: [{ Domain: "mail.zetca.pro", Status: "inactive" }], ...over } });

describe("CloudFront web hosts", () => {
  it("attaches the issued certificate to the tenant (the step that makes the domain go active)", async () => {
    cf.on(GetDistributionTenantCommand).resolves(tenant());
    cf.on(GetManagedCertificateDetailsCommand).resolves({ ManagedCertificateDetails: { CertificateStatus: "issued", CertificateArn: "arn:acm:cert-1" } });
    cf.on(UpdateDistributionTenantCommand).resolves({});
    expect(await hosts().status("dt_1")).toEqual({ active: false, certificate: "issued", attached: true });
    expect(cf.commandCalls(UpdateDistributionTenantCommand)[0]!.args[0].input).toMatchObject({ Id: "dt_1", IfMatch: "etag-1", Enabled: true, Domains: [{ Domain: "mail.zetca.pro" }], Customizations: { Certificate: { Arn: "arn:acm:cert-1" } } });
  });
  it("leaves the tenant alone while the certificate is pending, or once it's attached", async () => {
    cf.on(GetDistributionTenantCommand).resolves(tenant());
    cf.on(GetManagedCertificateDetailsCommand).resolves({ ManagedCertificateDetails: { CertificateStatus: "pending-validation", CertificateArn: "arn:acm:cert-1" } });
    expect(await hosts().status("dt_1")).toMatchObject({ certificate: "pending-validation", attached: false });
    cf.on(GetDistributionTenantCommand).resolves(tenant({ Customizations: { Certificate: { Arn: "arn:acm:cert-1" } }, Domains: [{ Domain: "mail.zetca.pro", Status: "active" }] }));
    cf.on(GetManagedCertificateDetailsCommand).resolves({ ManagedCertificateDetails: { CertificateStatus: "issued", CertificateArn: "arn:acm:cert-1" } });
    expect(await hosts().status("dt_1")).toEqual({ active: true, certificate: "issued", attached: true });
    expect(cf.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
  });
});
