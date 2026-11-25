/**
 * Security Rule Specification Test Matrix for /leaderboard/{entryId}
 * Covers the Dirty Dozen attack payloads documented in security_spec.md.
 */

export interface DirtyDozenCase {
  name: string;
  operation: 'create' | 'update' | 'delete' | 'list';
  entryId?: string;
  payload?: Record<string, unknown>;
  queryLimit?: number;
  expected: 'PERMISSION_DENIED';
}

export const dirtyDozenCases: DirtyDozenCase[] = [
  {
    name: 'Shadow/Ghost field injection',
    operation: 'create',
    entryId: 'valid_id_1',
    payload: { name: 'ACE', time: 45.2, createdAt: 'SERVER_TIME', isVerified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Missing required time field',
    operation: 'create',
    entryId: 'valid_id_2',
    payload: { name: 'ACE', createdAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Oversized name > 10 chars',
    operation: 'create',
    entryId: 'valid_id_3',
    payload: { name: 'ABCDEFGHIJK', time: 45.2, createdAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Whitespace-only name',
    operation: 'create',
    entryId: 'valid_id_4',
    payload: { name: '   ', time: 45.2, createdAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'XSS/symbol injection in name',
    operation: 'create',
    entryId: 'valid_id_5',
    payload: { name: '<script>', time: 45.2, createdAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Negative or sub-5s impossible time',
    operation: 'create',
    entryId: 'valid_id_6',
    payload: { name: 'HACKER', time: 0.01, createdAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Non-numeric time poisoning',
    operation: 'create',
    entryId: 'valid_id_7',
    payload: { name: 'ACE', time: '45.2', createdAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Spoofed client timestamp',
    operation: 'create',
    entryId: 'valid_id_8',
    payload: { name: 'ACE', time: 45.2, createdAt: '2020-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Oversized document ID > 128 chars',
    operation: 'create',
    entryId: 'a'.repeat(200),
    payload: { name: 'ACE', time: 45.2, createdAt: 'SERVER_TIME' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Update tampering on existing score',
    operation: 'update',
    entryId: 'valid_id_1',
    payload: { time: 5.1 },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Delete griefing on existing score',
    operation: 'delete',
    entryId: 'valid_id_1',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: 'Unbounded list scrape without limit <= 25',
    operation: 'list',
    queryLimit: 100,
    expected: 'PERMISSION_DENIED',
  },
];
