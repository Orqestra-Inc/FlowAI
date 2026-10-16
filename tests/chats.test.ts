import { describe, expect, it } from 'vitest';
import { openDb, seed } from '../server/db.js';
import { getChat, listChats, saveTurn } from '../server/domain/chats.js';
import type { Actor } from '../server/domain/types.js';

const brian: Actor = { userId: 'usr_procurement', email: 'procurement@baraka.demo', businessId: 'biz_baraka', role: 'procurement', displayName: 'Brian' };
const faith: Actor = { userId: 'usr_accountant', email: 'accountant@baraka.demo', businessId: 'biz_baraka', role: 'accountant', displayName: 'Faith' };

describe('chat history', () => {
  it('stores turns per user and conversation, updates in place, and never leaks across users', () => {
    const db = openDb(':memory:');
    seed(db);
    const t1 = { id: 't1', chatId: 'c1', message: 'Low stock?', protected: true, events: [{ type: 'start' }], createdAt: '2026-10-16T10:00:00Z' };
    saveTurn(db, brian, t1);
    saveTurn(db, brian, { ...t1, events: [{ type: 'start' }, { type: 'final', text: 'Oil and rice.' }] });
    saveTurn(db, brian, { id: 't2', chatId: 'c2', message: 'Cash?', protected: true, events: [], createdAt: '2026-10-16T11:00:00Z' });

    const c1 = getChat(db, brian, 'c1');
    expect(c1).toHaveLength(1);
    expect(c1[0].events).toHaveLength(2);
    expect(listChats(db, brian).map((c) => [c.chatId, c.title])).toEqual([['c2', 'Cash?'], ['c1', 'Low stock?']]);

    expect(getChat(db, faith, 'c1')).toEqual([]);
    expect(listChats(db, faith)).toEqual([]);

    seed(db); // demo reset clears history
    expect(listChats(db, brian)).toEqual([]);
  });
});
