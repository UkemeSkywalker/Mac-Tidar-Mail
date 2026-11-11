// Mac Tidar Mail can be opened on a company's own web address (mail.<their domain>). The app is
// the same static site; it works out the company from the host it's served on.

/** Our own hosts, where nothing is company-branded up front. */
const OWN_HOSTS = /^(?:mail\.mactidar\.com|.*\.amplifyapp\.com|localhost|127\.0\.0\.1)$/i;

/** The company domain when the app is open on mail.<domain> (e.g. "zetca.pro"), else null. */
export function companyDomainFromHost(hostname = typeof location === "undefined" ? "" : location.hostname): string | null {
  const host = hostname.toLowerCase();
  if (OWN_HOSTS.test(host) || !host.startsWith("mail.")) return null;
  const domain = host.slice(5);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}
