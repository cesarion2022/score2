# Security Specification — Billar Pro Firestore

## 1. Data Invariants
1. **Default-Deny Catch-All**: Any path not explicitly matched under `/databases/{database}/documents` is denied for both read and write.
2. **Verified Identity & Ownership**: Every read and write requires `request.auth != null`, `request.auth.token.email_verified == true`, and `request.auth.uid == userId` (or bootstrapped verified admin for administrative overrides).
3. **PII Isolation**: User email is isolated in `/users/{userId}/private/info` and never exposed in `/users/{userId}` or readable by non-owners.
4. **Strict Keys & No Shadow Fields**: Every create/update validates `data.keys().hasAll(...)` and `data.keys().hasOnly(...)`, plus `affectedKeys().hasOnly(...)` on updates.
5. **Immutable Ownership & Temporal Integrity**: `uid` and `createdAt` cannot be modified after creation; `createdAt`/`updatedAt` must equal `request.time`.
6. **Bounded Strings, Numbers & Arrays**: All document IDs match `^[a-zA-Z0-9_\-]+$` with `size() <= 128`; arrays (`sc`, `sets`, `names`, `colors`, `inv`) are strictly size-bounded (`<= 6` or `<= 100`).
7. **Master Gate on Subcollections**: Every subcollection under `/users/{userId}/...` verifies parent user document existence via `exists(/databases/$(database)/documents/users/$(userId))` on writes (except initial profile creation).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: `auth = null` reading `/users/u1/club/settings` -> `PERMISSION_DENIED`.
2. **Cross-User Profile Hijack**: `u2` writing `/users/u1` with `uid: "u1"` -> `PERMISSION_DENIED`.
3. **UID Spoofing on Create**: `u2` writing `/users/u2` with `uid: "u1"` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection**: `u1` creating `/users/u1` with extra key `isAdmin: true` -> `PERMISSION_DENIED`.
5. **Email Spoofing (Unverified Email)**: User with `email: "cesaraugustodiazp@gmail.com"` and `email_verified: false` accessing `/users/other` -> `PERMISSION_DENIED`.
6. **PII Leak**: `u2` reading `/users/u1/private/info` -> `PERMISSION_DENIED`.
7. **ID Poisoning (1.5KB Document ID)**: `u1` creating `/users/u1/sales/<1500 chars>` -> `PERMISSION_DENIED`.
8. **Type Poisoning on Update**: `u1` updating `/users/u1/tables/1` setting `rate: "not-a-number"` or `sc: "invalid"` -> `PERMISSION_DENIED`.
9. **Array Overflow (Denial of Wallet)**: `u1` updating `/users/u1/club/settings` with `inv` having 101 items or `names` having 7 items -> `PERMISSION_DENIED`.
10. **Immutable Field Tampering**: `u1` updating `/users/u1` changing `createdAt` or `uid` -> `PERMISSION_DENIED`.
11. **Client-Forged Timestamp**: `u1` creating `/users/u1/sales/s1` with `createdAt` != `request.time` -> `PERMISSION_DENIED`.
12. **Blanket List Query Scraping**: `u2` listing `/users/u1/sales` -> `PERMISSION_DENIED`.
