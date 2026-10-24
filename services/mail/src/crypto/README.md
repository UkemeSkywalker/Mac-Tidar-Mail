# Mail crypto core

This is the OpenPGP layer shared by the Lambdas (`services/mail/src/*`) and the browser
(`components/mail/crypto/`, which re-exports this folder through `core.ts`). It uses
`openpgp` 6.3.2, pinned in both `package.json` files. Every openpgp call goes through
this folder, so only one copy of the library is ever loaded.

Tests: `cd services/mail && npm test`. The browser modules are tested from
`services/mail/test/browser/`, using `fake-indexeddb` and Node's WebCrypto.

## Key formats

| Item | Format |
|---|---|
| Mailbox key | v4 OpenPGP: an Ed25519 primary key (signs) plus an X25519 subkey (encrypts). It uses the "legacy" Curve25519 encoding because GnuPG, Proton and Thunderbird can read it. User ID is `Name <addr>`. |
| Stored private key | Armored. Encrypted with **Argon2id S2K + AEAD** (s2k usage 253). By default t=3, p=4, m=64 MiB (RFC 9106). Memory is capped at 2^20 KiB on both lock and unlock, so a tampered blob can't make a browser allocate more than that. |
| Key passphrase | `hex(SHA-256("mactidar-mail/key-passphrase/v1\0" + address + "\0" + password))`. The hash is only domain separation; Argon2 inside the S2K does the slow, expensive stretching. |
| Message header | Armored OpenPGP message of JSON `{v:1, subject, preview, fromName, attachments:[{filename, contentType, size, contentId?, inline?}]}`. Stored in DynamoDB. |
| Message body | Binary OpenPGP message of JSON `{v:1, text, html?}`. Stored in S3. |
| Attachment | Binary OpenPGP message of the raw bytes, one per attachment. `attachments[i]` matches `header.attachments[i]`. |
| Signatures | Embedded in Mac Tidar → Mac Tidar mail. Decrypting reports one of `verified`, `invalid`, `unverified` (no keys were given to check against) or `unsigned`. Detached signatures are available through `signDetached` / `verifyDetached`. |

`MailboxKeyState` (in `keyring-types.ts`) is the record stored per mailbox in
DynamoDB at `MAILBOX#addr/META`:

```
{ version: 1, address, primaryFingerprint,
  keys: [{ fingerprint, publicKey, privateKey /* locked */, status: "active" | "locked", createdAt }],
  recovery: { fingerprint, publicKey, privateKey /* locked under recovery code */,
              copies: { [mailboxKeyFingerprint]: armored message of that unlocked key, encrypted to the recovery key } } }
```

An `active` key is locked under the current password. A `locked` key is still locked
under an older password, until one of the recovery methods below opens it. Every
private key in this record needs a secret that only the user holds. **There is no
escrow key.**

## Flows

- **Inbound (Lambda).** `encryptInboundMessage(parsed, recipientPublicKey)` returns
  `{header, body, attachments[]}`, all ciphertext. Map mailparser's `from.value[0]`
  into `from`. As soon as the call resolves, drop every plaintext reference and
  delete the raw S3 object.
- **First sign-in.** `setupMailboxKeys({address, password}, {device})` creates the
  mailbox key and a separate **recovery key**. The recovery private key is locked
  under a 256-bit recovery code (Crockford base32, 13 groups of 4 characters). Show
  the code once and offer `recovery.file` as a download. The server never sees the
  code.
- **Unlock.** `unlockMailbox(state, password, {device})` returns a `MailboxSession`.
  Decrypted keys and the derived passphrase live only in its private fields.
  `session.lock()` drops them, and `startAutoLock(session, {idleMs})` calls it after
  a period with no activity (15 minutes by default). If this device holds copies of
  `locked` keys, the unlock restores them onto the current password, and the caller
  should save the returned `state`.
- **Password reset** (`resetMailboxKeys(state, newPassword, {device})`). This always
  succeeds: a new key becomes primary, so new mail is readable immediately, and older
  keys become `locked`. Device recovery runs right away. Old keys can come back later
  through any of these:
  1. **Device.** Each browser keeps a non-extractable AES-GCM-256 key in IndexedDB
     (`mactidar-mail-device`). It wraps a copy of every unlocked key, and the copy is
     bound by AAD to the address and fingerprint. A copy never leaves the device.
     `unlockMailbox` and `session.restoreFromDevice` use it.
  2. **Recovery file or phrase.** `session.restoreWithRecovery(state, fileOrCode)`
     unlocks the recovery key, checks its fingerprint against the file and the
     server's copy, decrypts the recovery copies and re-locks them under the new
     password. It also backs up any key that isn't covered yet, so one recovery file
     keeps working across any number of resets.
  3. **Old password.** `session.unlockWithOldPassword(state, oldPassword)`.
- **New keys and the recovery key.** A new key gets a recovery copy without the code
  only when this device has the recovery key's fingerprint pinned (pinning happens at
  setup or restore). Otherwise a malicious server could swap in its own "recovery"
  key. `resetMailboxKeys` reports this as `recoveryCovered`.

## Callers must

- Sign in to Cognito with **SRP** (`USER_SRP_AUTH`) so the password never reaches a
  server. Never use `USER_PASSWORD_AUTH` or the hosted UI password form for these
  mailboxes.
- Never log, persist or send a `MailboxSession`, a recovery code, a password or any
  decrypted part.
- Persist the returned `state` whenever `restored` is non-empty, and after a reset.

## Known limits

- Public keys are served by our API, so a malicious server could hand a sender the
  wrong recipient key. Fingerprint pinning or key transparency (WKD) is a later phase.
- A device copy means anyone who has the unlocked browser profile can recover the
  key. "Sign out and forget this device" should call `device.forget(address)`.
- JavaScript can't reliably wipe strings from memory. Locking drops the references
  and leaves the rest to the garbage collector.
