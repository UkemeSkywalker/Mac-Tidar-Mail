/**
 * Server-stored key material for one mailbox (DynamoDB `MAILBOX#addr/META`).
 * Every private key in here is encrypted to a secret only the user holds.
 */
export interface MailboxKeyState {
  version: 1;
  address: string;
  /** Key that new mail is encrypted to. */
  primaryFingerprint: string;
  keys: StoredMailboxKey[];
  recovery: StoredRecoveryKey | null;
}

/**
 * `active`: `privateKey` is locked under the current password.
 * `locked`: locked under an older password (after a reset) until recovered.
 */
export type KeyStatus = "active" | "locked";

export interface StoredMailboxKey {
  fingerprint: string;
  /** Armored public key. */
  publicKey: string;
  /** Armored private key, Argon2id S2K + AEAD. */
  privateKey: string;
  status: KeyStatus;
  createdAt: string;
}

export interface StoredRecoveryKey {
  fingerprint: string;
  publicKey: string;
  /** Armored private key locked under the user's recovery code (Argon2id S2K + AEAD). */
  privateKey: string;
  /** Mailbox key fingerprint → armored OpenPGP message of that unlocked key, encrypted to the recovery key only. */
  copies: Record<string, string>;
}
