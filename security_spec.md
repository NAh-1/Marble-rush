# Marble Rush Global Leaderboard Security Specification

## 1. Data Invariants
1. **No PII**: `/leaderboard/{entryId}` documents only contain `name`, `time`, and `createdAt`. No emails, phone numbers, or user credentials are stored.
2. **Strict Schema**: Every document MUST have `['name', 'time', 'createdAt']` and ONLY `['name', 'time', 'createdAt']` (no ghost/shadow fields).
3. **Name Integrity**: `name` MUST be a string of length 1–10 matching `^[A-Z0-9 ]{1,10}$` and not whitespace-only (`name.trim().size() >= 1`).
4. **Time Bounds**: `time` MUST be a `number` (int or float) in `[5, 3600]` so impossible negative/zero times or absurd values are rejected.
5. **Temporal Integrity**: `createdAt` MUST equal `request.time` (server timestamp).
6. **Append-Only**: Existing leaderboard entries cannot be updated or deleted from clients (`allow update, delete: if false;`), preventing score tampering or griefing.
7. **Bounded List Queries**: `allow list` enforces `request.query.limit <= 25` to prevent unbounded collection dumps.
8. **Path ID Hardening**: `entryId` MUST match `^[a-zA-Z0-9_-]+$` and length `<= 128`.

## 2. The "Dirty Dozen" Attack Payloads
1. **Shadow/Ghost Field Injection**: `{ name: "ACE", time: 45.2, createdAt: serverTimestamp, isVerified: true }` -> `PERMISSION_DENIED`
2. **Missing Required Field**: `{ name: "ACE", createdAt: serverTimestamp }` -> `PERMISSION_DENIED`
3. **Oversized Name (>10 chars)**: `{ name: "ABCDEFGHIJK", time: 45.2, createdAt: serverTimestamp }` -> `PERMISSION_DENIED`
4. **Empty / Whitespace Name**: `{ name: "   ", time: 45.2, createdAt: serverTimestamp }` -> `PERMISSION_DENIED`
5. **XSS / Lowercase / Symbol Injection in Name**: `{ name: "<script>", time: 45.2, createdAt: serverTimestamp }` -> `PERMISSION_DENIED`
6. **Negative / Zero Time Cheat**: `{ name: "HACKER", time: 0.01, createdAt: serverTimestamp }` -> `PERMISSION_DENIED`
7. **Non-Numeric Time Type Poisoning**: `{ name: "ACE", time: "45.2", createdAt: serverTimestamp }` -> `PERMISSION_DENIED`
8. **Spoofed Client Timestamp**: `{ name: "ACE", time: 45.2, createdAt: "2020-01-01T00:00:00Z" }` -> `PERMISSION_DENIED`
9. **Oversized Document ID (>128 chars)**: `create` at `/leaderboard/${"a".repeat(200)}` -> `PERMISSION_DENIED`
10. **Score Update Tampering**: `update` on existing `/leaderboard/{entryId}` changing `time` to `5.1` -> `PERMISSION_DENIED`
11. **Score Deletion Griefing**: `delete` on existing `/leaderboard/{entryId}` -> `PERMISSION_DENIED`
12. **Unbounded List Scrape**: `getDocs(collection(db, "leaderboard"))` without `limit <= 25` -> `PERMISSION_DENIED`
