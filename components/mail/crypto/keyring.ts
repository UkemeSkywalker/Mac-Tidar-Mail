import {
  DEFAULT_KDF,
  WrongPassphraseError,
  decryptAttachment,
  decryptBlob,
  decryptMessageBody,
  decryptMessageHeader,
  deriveKeyPassphrase,
  encryptBlob,
  encryptMessageParts,
  generateMailboxKey,
  lockPrivateKey,
  normalizeAddress,
  parseUnlockedKey,
  readPublicKey,
  serializeUnlockedKey,
  unlockPrivateKey,
  type EncryptedMessage,
  type KdfParams,
  type MailboxKeyState,
  type MessageBody,
  type MessageHeader,
  type PrivateKey,
  type PublicKey,
  type StoredMailboxKey,
  type StoredRecoveryKey,
} from "./core";
import type { DeviceKeyStore } from "./device";
import { InvalidRecoveryCodeError, buildRecoveryFile, generateRecoveryCode, parseRecoveryInput } from "./recovery";

export class WrongPasswordError extends Error {
  constructor(message = "Wrong password") {
    super(message);
    this.name = "WrongPasswordError";
  }
}

export class SessionLockedError extends Error {
  constructor(message = "Mailbox is locked; unlock it with your password") {
    super(message);
    this.name = "SessionLockedError";
  }
}

export interface KeyringOptions {
  /** Argon2 cost. Leave unset outside tests. */
  kdf?: KdfParams;
  /** This browser's device key store. Omit to skip device recovery (e.g. private browsing). */
  device?: DeviceKeyStore | null;
}

/** Result of anything that may bring locked keys back. Persist `state` to the server when `restored` is non-empty. */
export interface RestoreResult {
  state: MailboxKeyState;
  /** Fingerprints that moved from `locked` to `active`. */
  restored: string[];
}

export function lockedKeyCount(state: MailboxKeyState): number {
  return state.keys.filter((k) => k.status === "locked").length;
}

const now = () => new Date().toISOString();

async function storedKey(key: PrivateKey, passphrase: string, kdf: KdfParams): Promise<StoredMailboxKey> {
  return {
    fingerprint: key.getFingerprint(),
    publicKey: key.toPublic().armor(),
    privateKey: await lockPrivateKey(key, passphrase, kdf),
    status: "active",
    createdAt: now(),
  };
}

/** Encrypt an unlocked mailbox key to the recovery public key (no secret needed to add new copies). */
async function recoveryCopy(key: PrivateKey, recoveryPublicKey: PublicKey): Promise<string> {
  const bytes = serializeUnlockedKey(key);
  try {
    return await encryptBlob(bytes, { encryptionKeys: [recoveryPublicKey] });
  } finally {
    bytes.fill(0);
  }
}

/**
 * Only back up a new key to the server's recovery key if this device already
 * trusts that recovery key. Otherwise a malicious server could swap in its own
 * "recovery" key and receive a copy of every new private key.
 */
async function trustedRecoveryKey(
  state: MailboxKeyState,
  device: DeviceKeyStore | null | undefined,
): Promise<PublicKey | null> {
  if (!state.recovery || !device) return null;
  const pinned = await device.getRecoveryFingerprint(state.address);
  if (!pinned) return null;
  const key = await readPublicKey(state.recovery.publicKey);
  return key.getFingerprint() === pinned && state.recovery.fingerprint === pinned ? key : null;
}

/**
 * The unlocked keyring for one mailbox. Decrypted keys and the derived
 * passphrase live only in this object's private fields and are dropped by
 * `lock()`. Never serialize it.
 */
export class MailboxSession {
  readonly address: string;
  readonly primaryFingerprint: string;
  readonly #kdf: KdfParams;
  #keys: Map<string, PrivateKey> | null;
  #passphrase: string | null;

  constructor(init: {
    address: string;
    primaryFingerprint: string;
    keys: PrivateKey[];
    passphrase: string;
    kdf: KdfParams;
  }) {
    this.address = init.address;
    this.primaryFingerprint = init.primaryFingerprint;
    this.#kdf = init.kdf;
    this.#keys = new Map(init.keys.map((k) => [k.getFingerprint(), k]));
    this.#passphrase = init.passphrase;
    if (!this.#keys.has(init.primaryFingerprint)) throw new Error("Primary key missing from session");
  }

  get locked(): boolean {
    return this.#keys === null;
  }

  lock(): void {
    this.#keys = null;
    this.#passphrase = null;
  }

  #unlocked(): { keys: Map<string, PrivateKey>; passphrase: string } {
    if (!this.#keys || !this.#passphrase) throw new SessionLockedError();
    return { keys: this.#keys, passphrase: this.#passphrase };
  }

  /** All unlocked keys, primary first. */
  decryptionKeys(): PrivateKey[] {
    const { keys } = this.#unlocked();
    const primary = keys.get(this.primaryFingerprint)!;
    return [primary, ...[...keys.values()].filter((k) => k !== primary)];
  }

  signingKey(): PrivateKey {
    return this.#unlocked().keys.get(this.primaryFingerprint)!;
  }

  primaryPublicKey(): PublicKey {
    return this.signingKey().toPublic();
  }

  /** Mac Tidar → Mac Tidar: encrypt to recipients plus our own key (for Sent), signed by us. */
  encryptMessage(parts: { header: MessageHeader; body: MessageBody }, recipients: PublicKey[]): Promise<EncryptedMessage> {
    return encryptMessageParts(parts, {
      encryptionKeys: [...recipients, this.primaryPublicKey()],
      signingKey: this.signingKey(),
    });
  }

  async decryptHeader(armored: string, opts: { verificationKeys?: PublicKey[] } = {}) {
    return decryptMessageHeader(armored, { decryptionKeys: this.decryptionKeys(), ...opts });
  }

  async decryptBody(ciphertext: Uint8Array, opts: { verificationKeys?: PublicKey[] } = {}) {
    return decryptMessageBody(ciphertext, { decryptionKeys: this.decryptionKeys(), ...opts });
  }

  async decryptAttachment(ciphertext: Uint8Array, opts: { verificationKeys?: PublicKey[] } = {}) {
    return decryptAttachment(ciphertext, { decryptionKeys: this.decryptionKeys(), ...opts });
  }

  /** Keep a device-wrapped copy of every unlocked key in this browser. */
  async rememberOnDevice(device: DeviceKeyStore): Promise<void> {
    await device.saveKeys(this.address, this.decryptionKeys());
  }

  /** Re-lock recovered keys under the current password and add them to this session. */
  async #adopt(state: MailboxKeyState, recovered: PrivateKey[]): Promise<RestoreResult> {
    const { keys, passphrase } = this.#unlocked();
    const byFingerprint = new Map(recovered.map((k) => [k.getFingerprint(), k]));
    const restored: string[] = [];
    const next: StoredMailboxKey[] = [];
    for (const stored of state.keys) {
      const key = stored.status === "locked" ? byFingerprint.get(stored.fingerprint) : undefined;
      if (!key) {
        next.push(stored);
        continue;
      }
      next.push({ ...stored, privateKey: await lockPrivateKey(key, passphrase, this.#kdf), status: "active" });
      keys.set(stored.fingerprint, key);
      restored.push(stored.fingerprint);
    }
    return { state: { ...state, keys: next }, restored };
  }

  /** Remembered the password from before a reset: unlock every locked key it opens. */
  async unlockWithOldPassword(state: MailboxKeyState, oldPassword: string): Promise<RestoreResult> {
    this.#unlocked();
    const passphrase = await deriveKeyPassphrase(oldPassword, this.address);
    const recovered: PrivateKey[] = [];
    for (const stored of state.keys.filter((k) => k.status === "locked")) {
      try {
        recovered.push(await unlockPrivateKey(stored.privateKey, passphrase));
      } catch (e) {
        if (!(e instanceof WrongPassphraseError)) throw e;
      }
    }
    if (recovered.length === 0) throw new WrongPasswordError("That password does not unlock any older keys");
    return this.#adopt(state, recovered);
  }

  /** Restore locked keys from the server's recovery copies using the recovery file or typed code. */
  async restoreWithRecovery(
    state: MailboxKeyState,
    fileOrCode: string,
    options: { device?: DeviceKeyStore | null } = {},
  ): Promise<RestoreResult> {
    this.#unlocked();
    const input = parseRecoveryInput(fileOrCode);
    if (input.address && normalizeAddress(input.address) !== this.address) {
      throw new InvalidRecoveryCodeError("This recovery file belongs to another mailbox");
    }
    if (!state.recovery) throw new InvalidRecoveryCodeError("This mailbox has no recovery key set up");
    let recoveryKey: PrivateKey;
    try {
      recoveryKey = await unlockPrivateKey(state.recovery.privateKey, input.code);
    } catch (e) {
      if (e instanceof WrongPassphraseError) throw new InvalidRecoveryCodeError("Wrong recovery code");
      throw e;
    }
    const fingerprint = recoveryKey.getFingerprint();
    if ((input.fingerprint && input.fingerprint.toLowerCase() !== fingerprint) || state.recovery.fingerprint !== fingerprint) {
      throw new InvalidRecoveryCodeError("The recovery key on the server does not match this recovery file");
    }

    const recovered: PrivateKey[] = [];
    for (const stored of state.keys.filter((k) => k.status === "locked")) {
      const copy = state.recovery.copies[stored.fingerprint];
      if (!copy) continue;
      try {
        const { data } = await decryptBlob(copy, { decryptionKeys: [recoveryKey] });
        // Not zeroed: the parsed key keeps references into `data`.
        const key = await parseUnlockedKey(data);
        if (key.getFingerprint() === stored.fingerprint) recovered.push(key);
      } catch {
        // A corrupt copy only loses that one key; keep going.
      }
    }
    const result = await this.#adopt(state, recovered);

    // We have now proven the recovery key is ours, so back up any keys it does not cover yet.
    const recoveryPublic = recoveryKey.toPublic();
    const copies = { ...state.recovery.copies };
    for (const key of this.decryptionKeys()) {
      copies[key.getFingerprint()] ??= await recoveryCopy(key, recoveryPublic);
    }
    const device = options.device;
    if (device) {
      await device.pinRecoveryFingerprint(this.address, fingerprint);
      await this.rememberOnDevice(device);
    }
    return { ...result, state: { ...result.state, recovery: { ...state.recovery, copies } } };
  }

  /** Restore locked keys from this browser's device-wrapped copies. */
  async restoreFromDevice(state: MailboxKeyState, device: DeviceKeyStore): Promise<RestoreResult> {
    this.#unlocked();
    const result = lockedKeyCount(state) > 0 ? await this.#adopt(state, await device.loadKeys(this.address)) : { state, restored: [] };
    await this.rememberOnDevice(device);
    return result;
  }
}

export interface SetupResult {
  state: MailboxKeyState;
  session: MailboxSession;
  /** Show once, offer as a download, then forget. The server never sees `code`. */
  recovery: { code: string; file: string; fingerprint: string };
}

/** First sign-in: create the mailbox key and recovery key, locked under the password and recovery code. */
export async function setupMailboxKeys(
  input: { address: string; password: string; displayName?: string },
  options: KeyringOptions = {},
): Promise<SetupResult> {
  const kdf = options.kdf ?? DEFAULT_KDF;
  const address = normalizeAddress(input.address);
  const passphrase = await deriveKeyPassphrase(input.password, address);
  const code = generateRecoveryCode();

  const [mailbox, recoveryKey] = await Promise.all([
    generateMailboxKey(address, { name: input.displayName }),
    generateMailboxKey(address, { name: "Mac Tidar Mail recovery" }),
  ]);
  const recovery: StoredRecoveryKey = {
    fingerprint: recoveryKey.fingerprint,
    publicKey: recoveryKey.publicKey,
    privateKey: await lockPrivateKey(recoveryKey.privateKey, code, kdf),
    copies: { [mailbox.fingerprint]: await recoveryCopy(mailbox.privateKey, recoveryKey.privateKey.toPublic()) },
  };
  const state: MailboxKeyState = {
    version: 1,
    address,
    primaryFingerprint: mailbox.fingerprint,
    keys: [await storedKey(mailbox.privateKey, passphrase, kdf)],
    recovery,
  };
  const session = new MailboxSession({
    address,
    primaryFingerprint: mailbox.fingerprint,
    keys: [mailbox.privateKey],
    passphrase,
    kdf,
  });
  if (options.device) {
    await session.rememberOnDevice(options.device);
    await options.device.pinRecoveryFingerprint(address, recovery.fingerprint);
  }
  return {
    state,
    session,
    recovery: { code, fingerprint: recovery.fingerprint, file: buildRecoveryFile({ address, code, fingerprint: recovery.fingerprint }) },
  };
}

/**
 * Sign-in: unlock every active key with the password. If this device holds
 * copies of keys that are locked (a reset happened elsewhere), they are
 * restored onto the current password automatically.
 */
export async function unlockMailbox(
  state: MailboxKeyState,
  password: string,
  options: KeyringOptions = {},
): Promise<{ session: MailboxSession } & RestoreResult> {
  const passphrase = await deriveKeyPassphrase(password, state.address);
  const primary = state.keys.find((k) => k.fingerprint === state.primaryFingerprint);
  if (!primary || primary.status !== "active") throw new Error("Mailbox key state has no active primary key");
  let primaryKey: PrivateKey;
  try {
    primaryKey = await unlockPrivateKey(primary.privateKey, passphrase);
  } catch (e) {
    if (e instanceof WrongPassphraseError) throw new WrongPasswordError();
    throw e;
  }
  if (primaryKey.getFingerprint() !== state.primaryFingerprint) throw new Error("Primary key does not match its fingerprint");

  const others: PrivateKey[] = [];
  for (const stored of state.keys) {
    if (stored.status !== "active" || stored === primary) continue;
    try {
      const key = await unlockPrivateKey(stored.privateKey, passphrase);
      if (key.getFingerprint() === stored.fingerprint) others.push(key);
    } catch {
      // Should not happen for an active key; leave it out rather than block sign-in.
    }
  }
  const session = new MailboxSession({
    address: state.address,
    primaryFingerprint: state.primaryFingerprint,
    keys: [primaryKey, ...others],
    passphrase,
    kdf: options.kdf ?? DEFAULT_KDF,
  });
  const result = options.device ? await session.restoreFromDevice(state, options.device) : { state, restored: [] };
  return { session, ...result };
}

/**
 * After a Cognito password reset: the account always works again. A fresh key
 * becomes primary (new mail is readable immediately); every older key is
 * marked `locked` until device copies, the recovery file, or the old password
 * bring it back. Device recovery is attempted right away.
 */
export async function resetMailboxKeys(
  state: MailboxKeyState,
  newPassword: string,
  options: KeyringOptions = {},
): Promise<{ session: MailboxSession; recoveryCovered: boolean } & RestoreResult> {
  const kdf = options.kdf ?? DEFAULT_KDF;
  const passphrase = await deriveKeyPassphrase(newPassword, state.address);
  const fresh = await generateMailboxKey(state.address);
  const recoveryPublic = await trustedRecoveryKey(state, options.device);

  const recovery = state.recovery && recoveryPublic
    ? { ...state.recovery, copies: { ...state.recovery.copies, [fresh.fingerprint]: await recoveryCopy(fresh.privateKey, recoveryPublic) } }
    : state.recovery;
  const next: MailboxKeyState = {
    ...state,
    primaryFingerprint: fresh.fingerprint,
    keys: [
      await storedKey(fresh.privateKey, passphrase, kdf),
      ...state.keys.map((k): StoredMailboxKey => ({ ...k, status: "locked" })),
    ],
    recovery,
  };
  const session = new MailboxSession({
    address: state.address,
    primaryFingerprint: fresh.fingerprint,
    keys: [fresh.privateKey],
    passphrase,
    kdf,
  });
  const result = options.device ? await session.restoreFromDevice(next, options.device) : { state: next, restored: [] };
  return { session, recoveryCovered: Boolean(recoveryPublic), ...result };
}
