// Demo mail data. Everything lives in the browser; nothing is sent anywhere.

export type Person = { name: string; email: string; title?: string };
export type Attachment = { name: string; size: string; icon: string };
export type FolderId = "inbox" | "starred" | "snoozed" | "sent" | "drafts" | "scheduled" | "archive" | "spam" | "trash";
export type Category = "primary" | "updates" | "newsletters";
export type LabelTone = "product" | "engineering" | "investors" | "design" | "invoices" | "security" | "custom";
export type Label = { name: string; tone: LabelTone };

export type Message = {
  id: string;
  thread: string;
  kind: "message" | "draft" | "scheduled";
  folder: "inbox" | "sent" | "archive" | "spam" | "trash";
  category: Category;
  from: Person;
  to: Person[];
  cc?: Person[];
  subject: string;
  body: string;
  rich?: "q3-roadmap";
  date: string;
  read: boolean;
  starred: boolean;
  urgent?: boolean;
  snoozedUntil: string | null;
  scheduledAt?: string | null;
  labels: string[];
  attachments: Attachment[];
};

export type Settings = { density: "comfortable" | "compact"; signature: string; notifications: boolean };
export type Mailbox = { messages: Message[]; labels: Label[]; settings: Settings };

export const accounts: (Person & { initials: string; role: string })[] = [
  { name: "Ukeme Eseme", email: "ukeme@mactidar.com", initials: "UE", role: "Founder & CEO • Mac Tidar Technologies" },
  { name: "Mac Tidar Admin", email: "admin@mactidar.com", initials: "MA", role: "Admin Operations" },
  { name: "Mac Tidar Hello", email: "hello@mactidar.com", initials: "MH", role: "Community" },
  { name: "Mac Tidar Support", email: "support@mactidar.com", initials: "MS", role: "Support Team" },
];

export const defaultLabels: Label[] = [
  { name: "Engineering", tone: "engineering" },
  { name: "Product", tone: "product" },
  { name: "Investors", tone: "investors" },
  { name: "Design", tone: "design" },
  { name: "Invoices", tone: "invoices" },
  { name: "Security", tone: "security" },
];

const people = {
  elena: { name: "Elena Rostova", email: "elena.rostova@mactidar.com", title: "VP of Product" },
  alex: { name: "Alex Rivera", email: "alex.rivera@mactidar.com", title: "Staff Infra" },
  aws: { name: "AWS Cloud Notifications", email: "no-reply@aws.amazon.com" },
  tariq: { name: "Tariq Al-Mansoor", email: "tariq@foundersfund.vc", title: "Founders Fund" },
  github: { name: "GitHub", email: "notifications@github.com" },
  amara: { name: "Amara Nwosu", email: "amara@mactidar.com", title: "Lead UI" },
  stripe: { name: "Stripe Billing", email: "invoices@stripe.com" },
  chidi: { name: "Chidi Okonkwo", email: "chidi@mactidar.com", title: "Head of Sec" },
  sara: { name: "Sara Lin", email: "sara.lin@mactidar.com", title: "Product" },
  awsBilling: { name: "AWS Cloud Billing", email: "billing@aws.amazon.com" },
  techcrunch: { name: "TechCrunch", email: "newsletters@techcrunch.com" },
  stratechery: { name: "Stratechery", email: "email@stratechery.com" },
} satisfies Record<string, Person>;

/** Contacts offered by recipient autocomplete. */
export const directory: Person[] = [
  { name: "Admin Operations", email: "admin@mactidar.com", title: "Team" },
  { name: "Mac Tidar Support", email: "support@mactidar.com", title: "Team" },
  ...Object.values(people),
];

type Seed = {
  from: Person; subject: string; body: string; hoursAgo: number; labels?: string[]; category?: Category;
  read?: boolean; starred?: boolean; urgent?: boolean; folder?: Message["folder"]; attachments?: Attachment[];
  thread?: string; rich?: Message["rich"]; to?: Person[];
};

// Inbox rows and threads from designs/inbox_* and designs/conversation_*.
const designSeeds: Seed[] = [
  { thread: "q3", from: { name: "Ukeme Eseme", email: "ukeme@mactidar.com" }, to: [people.elena, people.alex], subject: "Q3 Product Roadmap: Multi-tenant Architecture & Search Latency", hoursAgo: 46, read: true, labels: ["Product"], attachments: [{ name: "feasibility-study.pdf", size: "820 KB", icon: "picture_as_pdf" }],
    body: "Elena, let’s make sure we lock in the vector search latency targets before sharing with the investors on Thursday. I’ve attached the revised feasibility study.\n\nAlex — can you rerun the pgvector benchmarks against the OpenSearch cluster so we have like-for-like numbers?\n\nUkeme" },
  { thread: "q3", from: people.alex, to: [people.elena, { name: "Ukeme Eseme", email: "ukeme@mactidar.com" }], subject: "Q3 Product Roadmap: Multi-tenant Architecture & Search Latency", hoursAgo: 26, read: true, labels: ["Product"],
    body: "Benchmarked the PostgreSQL pgvector vs OpenSearch cluster. pgvector handled 12k concurrent queries under 35ms at p95 with the new HNSW parameters.\n\nFull profiles are in latency-benchmarks.csv — I’ll attach them to Elena’s summary.\n\nAlex" },
  { thread: "q3", from: people.elena, to: [{ name: "Ukeme Eseme", email: "ukeme@mactidar.com" }, people.alex], subject: "Q3 Product Roadmap: Multi-tenant Architecture & Search Latency", hoursAgo: 1, starred: true, urgent: true, labels: ["Product"], rich: "q3-roadmap",
    attachments: [{ name: "roadmap-v3.2.pdf", size: "1.4 MB", icon: "picture_as_pdf" }, { name: "latency-benchmarks.csv", size: "340 KB", icon: "table_chart" }],
    body: "Ukeme, here is the revised sprint scope for Q3. We benchmarked the new vector indexing against AWS OpenSearch and latency dropped by 42%..." },
  { from: people.aws, subject: "[Production Alert] AWS Amplify build succeeded for mail.mactidar.com (commit 7f4a91c)", hoursAgo: 2.5, labels: ["Engineering"],
    body: "Deployment completed in 1m 24s. Branch main is live at https://mail.mactidar.com. All 48 unit and integration tests passed." },
  { thread: "series-a", from: people.tariq, subject: "Follow-up: Mac Tidar Series A allocation & term sheet syndicate", hoursAgo: 22, starred: true, labels: ["Investors"],
    body: "Terrific catching up yesterday Ukeme. Our partners were deeply impressed by your retention metrics across the Nigerian tech corridor and enterprise pilots.\n\nWe conducted the syndicate partner sync this morning regarding Mac Tidar’s $18M Series A. The operational velocity and enterprise expansion figures look solid.\n\nCould you drop over the finalized data room cohort retention charts? Let's aim for a quick walk-through on Thursday.\n\nTariq" },
  { from: people.github, subject: "[mactidar/core-api] Pull Request #142 merged by dev-lead: Implement Webhook retry policies", hoursAgo: 25, read: true, labels: ["Engineering"],
    body: "dev-lead merged commit 88a10c into develop. Reviewers approved: @ukeme, @alex-tech." },
  { from: people.amara, subject: "Figma review: Design tokens and dark mode elevation specs for Mac Tidar Mail", hoursAgo: 72, read: true, labels: ["Design"], attachments: [{ name: "design-tokens-v2.json", size: "18 KB", icon: "data_object" }],
    body: "Hey Ukeme, updated the component library with strict WCAG 2.2 AA contrast ratios and refined our Lucide icon weights. Check frame 4 in Figma.\n\nAmara" },
  { from: people.stripe, subject: "Invoice #MT-2024-1082 paid ($12,450.00)", hoursAgo: 96, read: true, labels: ["Invoices"], attachments: [{ name: "invoice-1082.pdf", size: "96 KB", icon: "receipt_long" }],
    body: "Your payment to Amazon Web Services EMEA SARL was successful. A receipt has been attached." },
  { from: people.chidi, subject: "Quarterly SOC2 Type II Audit Preparation & IAM Key Rotation", hoursAgo: 120, read: true, labels: ["Security"],
    body: "Reminding all administrators that quarterly session tokens and KMS keys will rotate this Sunday at 02:00 UTC. Zero downtime expected.\n\nChidi" },
  { from: people.awsBilling, subject: "Invoice #99482 is ready for review", hoursAgo: 30, read: true, labels: ["Invoices"], category: "updates",
    body: "Invoice #99482 is ready for review for org Mac-Tidar-Prod. Your current projected charges are within the budget alert threshold." },
  { from: people.sara, subject: "Updated interactive prototypes for high-frequency keyboard shortcuts", hoursAgo: 130, read: true, labels: ["Product", "Design"],
    body: "Updated interactive prototypes for high-frequency keyboard shortcuts are ready. The command palette now supports fuzzy matching and recent actions.\n\nSara" },
  { from: people.techcrunch, subject: "Daily: Africa’s fintech rails get a second wind", hoursAgo: 8, read: true, category: "newsletters",
    body: "Today’s top stories: payment infrastructure funding rebounds, open banking pilots expand in Lagos and Nairobi, and a quieter approach to productivity software." },
  { from: people.stratechery, subject: "The Aggregation of Attention", hoursAgo: 30, read: true, category: "newsletters",
    body: "This week: why calm software wins long-term retention, and what email clients can learn from the best command-line tools." },
];

// Older mail carried over from the original demo, spread across the past weeks.
const archiveSeeds: [string, string, string, string, string[], Category, string | null][] = [
  ["Amara Okafor", "amara@studio.works", "Brand review: final routes", "Hi Ukeme, the revised visual routes are attached. I especially like the quieter system for the mail product — it feels confident without trying too hard.", ["Design"], "primary", "presentation-v4.pdf"],
  ["GitHub", "notifications@github.com", "[MacTidar/mail] Fix keyboard navigation focus trap", "ukemeskywalker pushed 3 commits to the feature/command-palette branch. Review requested from you.", ["Engineering"], "updates", null],
  ["Jordan Lee", "jordan@framehouse.co", "Tuesday product sync", "Can we keep the product review to thirty minutes? I have added an outline and the open decisions.", ["Product"], "primary", "agenda.docx"],
  ["Linear", "updates@linear.app", "You were mentioned in MTM-24", "Asha mentioned you in “Define draft recovery behavior”. The issue moved to In progress.", ["Product"], "updates", null],
  ["Stripe", "invoices@stripe.com", "Your October invoice is ready", "Your invoice for Mac Tidar AI Venture Studio is now available. Amount due: ₦24,500.", ["Invoices"], "updates", "invoice-october.pdf"],
  ["Nadia Mensah", "nadia@northstar.africa", "A thoughtful introduction", "Ukeme — I enjoyed your note on building useful AI media products. Would love to compare notes next week.", ["Investors"], "primary", null],
  ["Figma", "notify@figma.com", "New comments in Mac Tidar Mail", "Amara left 4 comments in “Mail experience / desktop”.", ["Design"], "updates", null],
  ["The Browser Company", "hello@thebrowser.company", "A calmer way to work online", "A few ideas for creating focus in your browser. Read when you have a quiet moment.", [], "newsletters", null],
  ["Security Center", "alerts@mactidar.com", "New demo sign-in from Lagos", "A simulated sign-in to your Mac Tidar account was recorded from Lagos, NG.", ["Security"], "primary", null],
  ["Paystack", "updates@paystack.com", "Product update: dashboard improvements", "Your team can now review payout information with a clearer activity timeline.", ["Invoices"], "updates", null],
  ["Workspace", "calendar@mactidar.com", "Invitation: Mac Tidar weekly planning", "You have been invited to Mac Tidar weekly planning, tomorrow at 10:00 WAT.", ["Product"], "primary", "invite.ics"],
  ["Growth Digest", "digest@growthnotes.com", "Five ideas worth keeping", "A short, editorial collection for people building products with conviction.", [], "newsletters", null],
];

const fileIcon = (name: string) => name.endsWith(".pdf") ? "picture_as_pdf" : name.endsWith(".csv") || name.endsWith(".xlsx") ? "table_chart" : name.endsWith(".json") ? "data_object" : name.endsWith(".ics") ? "event" : "description";

export function makeMailbox(account: Person, now = Date.now()): Mailbox {
  const me = { name: account.name, email: account.email };
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  let n = 0;
  const make = (s: Seed): Message => ({
    id: `m${++n}`, thread: s.thread ?? `t${n}`, kind: "message", folder: s.folder ?? "inbox", category: s.category ?? "primary",
    from: s.from.email === "ukeme@mactidar.com" ? me : s.from, to: (s.to ?? [me]).map(p => p.email === "ukeme@mactidar.com" ? me : p),
    subject: s.subject, body: s.body, rich: s.rich, date: at(s.hoursAgo), read: s.read ?? false, starred: s.starred ?? false, urgent: s.urgent,
    snoozedUntil: null, labels: s.labels ?? [], attachments: s.attachments ?? [],
  });
  const messages = designSeeds.map(make);
  for (let i = 0; i < 48; i++) {
    const [name, email, subject, body, labels, category, file] = archiveSeeds[i % archiveSeeds.length];
    messages.push(make({
      from: { name, email }, subject: i < archiveSeeds.length ? subject : `${subject} (${Math.floor(i / archiveSeeds.length) + 1})`, body, labels, category,
      hoursAgo: 144 + i * 19, read: i % 5 !== 0, starred: i % 17 === 0, folder: i % 11 === 10 ? "archive" : "inbox",
      attachments: file ? [{ name: file, size: ["1.2 MB", "348 KB", "2.4 MB"][i % 3], icon: fileIcon(file) }] : [],
    }));
  }
  messages.push(make({ from: { name: "Unknown Sender", email: "winner@fast-cash.biz" }, subject: "YOU HAVE WON ₦5,000,000!!!", body: "Urgent action required to release your prize. Send your details now.", hoursAgo: 50, folder: "spam" }));
  messages.push(make({ thread: "series-a", from: me, to: [people.tariq], subject: "Re: Mac Tidar Series A allocation & term sheet syndicate", hoursAgo: 21, read: true, folder: "sent", labels: ["Investors"],
    body: "Hi Tariq,\n\nThank you for the thoughtful feedback. We have finalized our Q3 metrics and would love to walk your investment committee through our updated data room on Thursday.\n\nUkeme" }));
  return { messages, labels: defaultLabels.map(l => ({ ...l })), settings: { density: "comfortable", signature: `${account.name}\nMac Tidar Technologies`, notifications: true } };
}
