export type ProviderId = 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'fastmail' | 'custom';

export type Auth =
  | { kind: 'password'; user: string; password: string }
  | { kind: 'microsoft'; user: string; accessToken: () => Promise<string> };

export interface ConnectOptions {
  provider: ProviderId;
  auth: Auth;
  /** Custom provider only. */
  host?: string;
  /** Custom provider only. */
  port?: number;
  /** Custom provider only. */
  secure?: boolean;
  /** Overrides the preset's folders. */
  folders?: string[];
  /** Default 30 000. */
  timeoutMs?: number;
}

export interface RequireAny {
  /** One of these words or phrases must appear, as a whole word, ignoring case and accents. */
  words: string[];
  /** Default ['subject']; 'from' covers name and address. */
  fields?: ('from' | 'subject')[];
}

export interface Query {
  /** Match when the sender's address ends with @domain or .domain. */
  fromDomains?: string[];
  /** Match when the phrase appears in one of phraseFields. */
  phrases?: string[];
  /** Default ['from', 'subject']; 'from' covers name and address. */
  phraseFields?: ('from' | 'subject' | 'body')[];
  /** Also require one of these words; an empty list sets no requirement. */
  requireAny?: RequireAny;
  /** Never match these sender addresses. */
  excludeFrom?: string[];
  /** Received on or after this day (UTC date). */
  since?: Date;
}

export interface Address {
  name: string | null;
  address: string;
}

export interface MessageRef {
  folder: string;
  uid: number;
  uidValidity: string;
  /** Message-ID when present, else `${folder}:${uidValidity}:${uid}`. */
  key: string;
  date: Date | null;
  from: Address | null;
  subject: string;
}

export interface Message extends MessageRef {
  to: Address[];
  cc: Address[];
  /** Plain text; HTML converted; capped (default 100 000 chars). */
  text: string;
  /** Allowlist: Message-ID, Date, From, To, Cc, Reply-To, List-Id. */
  headers: Record<string, string>;
  attachments: { filename: string | null; contentType: string; size: number }[];
  sizeBytes: number;
}
