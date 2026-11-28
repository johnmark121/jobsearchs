// Security-rule tests, run inside the Firestore emulator:  npm run test:rules
// Each test writes data exactly the way the game's Online code does, then checks that the rules
// allow what the game needs and deny everything else.
import {test, before, after, beforeEach} from 'node:test';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment, assertSucceeds, assertFails} from '@firebase/rules-unit-testing';
import {doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, getDocs, serverTimestamp} from 'firebase/firestore';

let env;
const ALICE = 'alice', BOB = 'bob', EVE = 'eve';
const genome = (name, sex, species = 'wolf') => ({species, gen: 1, parents: null, name, sex, morph: 'brown', hue: 28, sat: 0.27, lit: 0.18, contrast: 1,
  size: 1, leg: 1, eye: 1, abd: 1, speed: 1, chevrons: 4, traits: {bold: 0.5, curious: 0.5, active: 0.5, affection: 0.5}});
const summary = (uid, ownerName, o = {}) => ({owner: uid, ownerName, name: 'Karo', sex: 'female', morph: 'brown', gen: 1, parents: null, stage: 6, adult: true,
  genome: genome('Karo', 'female'), stats: {meals: 10, hunts: 12, catches: 9}, updated: serverTimestamp(), bornAt: Date.now() - 3600e3, ...o});
const db = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

before(async () => {
  env = await initializeTestEnvironment({projectId: 'demo-arachni', firestore: {rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')}});
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {   // seed: two players with profiles
    const f = ctx.firestore();
    await setDoc(doc(f, 'users', ALICE), {name: 'Alice', created: new Date()});
    await setDoc(doc(f, 'users', BOB), {name: 'Bob', created: new Date()});
  });
});

// ---------------------------------------------------------------- users
test('users: a new player can create their own profile', async () => {
  await assertSucceeds(setDoc(doc(db(EVE), 'users', EVE), {name: 'Eve', created: serverTimestamp()}));
});
test('users: cannot create a profile for someone else, or with bad/extra data', async () => {
  await assertFails(setDoc(doc(db(EVE), 'users', 'mallory'), {name: 'Eve', created: serverTimestamp()}));
  await assertFails(setDoc(doc(db(EVE), 'users', EVE), {name: 'E', created: serverTimestamp()}));
  await assertFails(setDoc(doc(db(EVE), 'users', EVE), {name: 'x'.repeat(21), created: serverTimestamp()}));
  await assertFails(setDoc(doc(db(EVE), 'users', EVE), {name: 'Eve', created: serverTimestamp(), admin: true}));
  await assertFails(setDoc(doc(db(null), 'users', EVE), {name: 'Eve', created: serverTimestamp()}));
});
test('users: profiles are private and names are permanent', async () => {
  await assertSucceeds(getDoc(doc(db(ALICE), 'users', ALICE)));
  await assertFails(getDoc(doc(db(BOB), 'users', ALICE)));
  await assertFails(updateDoc(doc(db(ALICE), 'users', ALICE), {name: 'Alicia'}));
});

// ---------------------------------------------------------------- saves
test('saves: only the owner can read and write their cloud save', async () => {
  const save = {json: JSON.stringify({v: 2}), at: serverTimestamp()};
  await assertSucceeds(setDoc(doc(db(ALICE), 'saves', ALICE), save));
  await assertSucceeds(getDoc(doc(db(ALICE), 'saves', ALICE)));
  await assertFails(getDoc(doc(db(BOB), 'saves', ALICE)));
  await assertFails(setDoc(doc(db(BOB), 'saves', ALICE), save));
});
test('saves: rejects oversized saves, extra fields and fake timestamps', async () => {
  await assertFails(setDoc(doc(db(ALICE), 'saves', ALICE), {json: 'x'.repeat(500001), at: serverTimestamp()}));
  await assertFails(setDoc(doc(db(ALICE), 'saves', ALICE), {json: '{}', at: serverTimestamp(), extra: 1}));
  await assertFails(setDoc(doc(db(ALICE), 'saves', ALICE), {json: '{}', at: new Date(0)}));
});

// ---------------------------------------------------------------- spiders (leaderboards)
test('spiders: owner publishes a valid summary; signed-in players can read it', async () => {
  await assertSucceeds(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice')));
  await assertSucceeds(getDoc(doc(db(BOB), 'spiders', ALICE)));
  await assertFails(getDoc(doc(db(null), 'spiders', ALICE)));
});
test('spiders: an egg summary (no bornAt, stage -1) is allowed', async () => {
  const s = summary(ALICE, 'Alice', {stage: -1, adult: false}); delete s.bornAt;
  await assertSucceeds(setDoc(doc(db(ALICE), 'spiders', ALICE), s));
});
test('spiders: every hatchable species (including new spiders) is accepted', async () => {
  for (const sp of ['wolf', 'huntsman', 'orb', 'jumper', 'widow', 'tarantula', 'scorpion', 'beetle'])
    await assertSucceeds(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {genome: genome('Karo', 'female', sp)})));
});
test('spiders: cannot impersonate, fake names or write invalid data', async () => {
  await assertFails(setDoc(doc(db(BOB), 'spiders', ALICE), summary(ALICE, 'Alice')));
  await assertFails(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'NotAlice')));
  await assertFails(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {stats: {meals: 1, hunts: 5, catches: 9}})));
  await assertFails(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {stage: 99})));
  await assertFails(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {genome: {...genome('Karo', 'female'), species: '<img onerror=x>'}})));
  await assertFails(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {genome: {...genome('Karo', 'female'), species: 'x'.repeat(40)}})));
  await assertFails(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {bornAt: Date.now() + 86400e3})));
  await assertFails(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {isAdmin: true})));
});
test('spiders: leaderboard anti-cheat limits catch jumps for the same critter', async () => {
  await assertSucceeds(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice')));
  await assertSucceeds(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {stats: {meals: 30, hunts: 40, catches: 29}})));
  await assertFails(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {stats: {meals: 9999, hunts: 9999, catches: 9999}})));
  // a brand-new critter (new name) may restart from zero
  await assertSucceeds(setDoc(doc(db(ALICE), 'spiders', ALICE), summary(ALICE, 'Alice', {name: 'Nubi', stats: {meals: 0, hunts: 0, catches: 0}})));
});

// ---------------------------------------------------------------- matings (courtship + eggs)
const request = (from, fromName, to, toName) => ({from, to, fromName, toName, fromSpider: {name: 'Karo', genome: genome('Karo', 'female')},
  toSpider: {name: 'Bram', genome: genome('Bram', 'male')}, status: 'pending', claimed: {}, created: serverTimestamp()});
async function seedRequest(status = 'pending', claimed = {}) {
  let id;
  await env.withSecurityRulesDisabled(async ctx => { const r = await addDoc(collection(ctx.firestore(), 'matings'), {...request(ALICE, 'Alice', BOB, 'Bob'), status, claimed, created: new Date()}); id = r.id; });
  return id;
}
test('matings: a player can send a valid courtship request', async () => {
  await assertSucceeds(addDoc(collection(db(ALICE), 'matings'), request(ALICE, 'Alice', BOB, 'Bob')));
});
test('matings: cannot forge the sender, court yourself, skip "pending" or court a non-player', async () => {
  await assertFails(addDoc(collection(db(EVE), 'matings'), request(ALICE, 'Alice', BOB, 'Bob')));
  await assertFails(addDoc(collection(db(ALICE), 'matings'), request(ALICE, 'Alice', ALICE, 'Alice')));
  await assertFails(addDoc(collection(db(ALICE), 'matings'), {...request(ALICE, 'Alice', BOB, 'Bob'), status: 'accepted'}));
  await assertFails(addDoc(collection(db(ALICE), 'matings'), request(ALICE, 'Alice', 'ghost', 'Ghost')));
  await assertFails(addDoc(collection(db(ALICE), 'matings'), request(ALICE, 'Mallory', BOB, 'Bob')));
});
test('matings: only the two partners can read; the game\'s "to me" / "from me" queries work', async () => {
  const id = await seedRequest();
  await assertSucceeds(getDoc(doc(db(ALICE), 'matings', id)));
  await assertSucceeds(getDoc(doc(db(BOB), 'matings', id)));
  await assertFails(getDoc(doc(db(EVE), 'matings', id)));
  await assertSucceeds(getDocs(query(collection(db(BOB), 'matings'), where('to', '==', BOB))));
  await assertSucceeds(getDocs(query(collection(db(ALICE), 'matings'), where('from', '==', ALICE))));
  await assertFails(getDocs(collection(db(EVE), 'matings')));
});
test('matings: only the recipient can accept or decline, once', async () => {
  const id = await seedRequest();
  await assertFails(updateDoc(doc(db(ALICE), 'matings', id), {status: 'accepted'}));
  await assertFails(updateDoc(doc(db(BOB), 'matings', id), {status: 'accepted', fromSpider: {name: 'X', genome: genome('X', 'female')}}));
  await assertSucceeds(updateDoc(doc(db(BOB), 'matings', id), {status: 'accepted', toSpider: {name: 'Bram', genome: genome('Bram', 'male')}}));
  await assertFails(updateDoc(doc(db(BOB), 'matings', id), {status: 'declined'}));
});
test('matings: each partner can only claim their own egg', async () => {
  const id = await seedRequest('accepted');
  await assertFails(updateDoc(doc(db(ALICE), 'matings', id), {['claimed.' + BOB]: true}));
  await assertSucceeds(updateDoc(doc(db(ALICE), 'matings', id), {['claimed.' + ALICE]: true}));
  await assertSucceeds(updateDoc(doc(db(BOB), 'matings', id), {['claimed.' + BOB]: true}));
  await assertFails(updateDoc(doc(db(EVE), 'matings', id), {['claimed.' + EVE]: true}));
  await assertFails(deleteDoc(doc(db(ALICE), 'matings', id)));
});
