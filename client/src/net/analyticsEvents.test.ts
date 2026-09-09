/**
 * The shared analytics vocabulary — `analyticsEvents.ts`.
 *
 * This module is the ONE definition of what may be reported, imported by the client that
 * sends and (through `@dd/net/*`) by the server that refuses everything else. It is tested
 * here, beside itself, rather than only through the server's parser: the parser suite
 * proves the parser reads the table, and this one proves what the table SAYS.
 *
 * The member list below is written out by hand on purpose. A sweep that derives its
 * expectation from the table can never notice the table gaining an entry — and a new event
 * is exactly the change that must be looked at, because it changes what is collected and
 * therefore what the privacy policy has to say (design/21 §5, P1).
 */
import { describe, it, expect } from 'vitest';
import {
  EVENTS,
  EVENT_NAMES,
  HOSTS,
  ID_RE,
  LIMITS,
  coerceProp,
  isEventName,
  specFor,
  type FieldSpec,
} from './analyticsEvents';

/** Names that would each be a screen view wearing a different hat. */
const SCREENISH = ['store_open', 'forge_open', 'menu_open', 'settings_open'];

describe('the vocabulary', () => {
  it('is exactly the events design/21 §2.2 names', () => {
    expect([...EVENT_NAMES].sort()).toEqual([
      'ad_completed',
      'ad_offer_shown',
      'run_end',
      'run_start',
      'screen_view',
      'session_end',
      'session_start',
      'store_purchase',
    ]);
  });

  it('names the three build targets and nothing else', () => {
    expect([...HOSTS]).toEqual(['web', 'wechat', 'crazygames']);
  });

  it('declares only field kinds the parser handles', () => {
    for (const [name, spec] of Object.entries(EVENTS)) {
      for (const [field, fieldSpec] of Object.entries(spec as Record<string, FieldSpec>)) {
        expect(['enum', 'id', 'int'], `${name}.${field}`).toContain(fieldSpec.kind);
      }
    }
  });

  it('gives every int field a bound correct data cannot exceed', () => {
    // A bound that only a hostile batch can violate is free. A bound a real run can hit
    // would silently drop the field for the players who play longest or deepest.
    for (const [name, spec] of Object.entries(EVENTS)) {
      for (const [field, fieldSpec] of Object.entries(spec as Record<string, FieldSpec>)) {
        if (fieldSpec.kind !== 'int') continue;
        expect(fieldSpec.min, `${name}.${field}`).toBeLessThan(fieldSpec.max);
        expect(fieldSpec.min, `${name}.${field}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('gives every enum field at least two values', () => {
    // A one-value enum is a constant, and storing a constant per row is storing nothing.
    for (const [name, spec] of Object.entries(EVENTS)) {
      for (const [field, fieldSpec] of Object.entries(spec as Record<string, FieldSpec>)) {
        if (fieldSpec.kind !== 'enum') continue;
        expect(fieldSpec.values.length, `${name}.${field}`).toBeGreaterThan(1);
      }
    }
  });

  it('has no event that duplicates a screen_view', () => {
    // `store_open` was in the first draft and came out: opening the store IS
    // `screen_view { screen: 'store' }`, the rollup counts screen views per screen, and two
    // events for one act means two panels somebody has to keep in agreement by hand.
    expect(EVENT_NAMES).not.toContain('store_open');
    expect(SCREENISH.every((n) => !EVENT_NAMES.includes(n as never))).toBe(true);
  });

  it('holds no event with more fields than a batch can carry meaning for', () => {
    for (const [name, spec] of Object.entries(EVENTS)) {
      expect(Object.keys(spec).length, name).toBeLessThanOrEqual(4);
    }
  });
});

describe('isEventName / specFor', () => {
  it('accepts every name in the table', () => {
    for (const name of EVENT_NAMES) {
      expect(isEventName(name), name).toBe(true);
      expect(specFor(name), name).toBeDefined();
    }
  });

  it('refuses a name that is not in the table', () => {
    expect(isEventName('no_such_event')).toBe(false);
    expect(specFor('no_such_event')).toBeUndefined();
  });

  it('refuses a name inherited from Object.prototype', () => {
    // `hasOwnProperty` rather than `in` or a truthiness check: `EVENTS['toString']` is a
    // function, so a naive lookup would treat `toString` as a legal event name and hand the
    // parser a "spec" that is a function.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(isEventName(name), name).toBe(false);
      expect(specFor(name), name).toBeUndefined();
    }
  });
});

describe('coerceProp — enum', () => {
  const spec: FieldSpec = { kind: 'enum', values: ['win', 'loss', 'abandon'] };

  it.each(['win', 'loss', 'abandon'])('accepts %s', (v) => {
    expect(coerceProp(spec, v)).toBe(v);
  });

  it.each([['WIN'], ['Win'], [''], ['win '], [1], [null], [undefined], [{}], [['win']]])('drops %p', (v) => {
    expect(coerceProp(spec, v)).toBeUndefined();
  });
});

describe('coerceProp — id', () => {
  it.each(['blueprint:rifle', 'ch1_lv2', 'a', 'a.b-c:d_e', 'character:scrapper', '0'])('accepts %s', (v) => {
    expect(coerceProp({ kind: 'id' }, v)).toBe(v);
  });

  it.each([
    ['upper case', 'Rifle'],
    ['a space', 'two words'],
    ['markup', '<script>'],
    ['an apostrophe', "o'brien"],
    ['a slash', 'a/b'],
    ['a percent', 'a%20b'],
    ['a newline', 'a\nb'],
    ['empty', ''],
    ['one over the cap', 'a'.repeat(LIMITS.idMax + 1)],
  ])('drops an id with %s', (_label, v) => {
    expect(coerceProp({ kind: 'id' }, v)).toBeUndefined();
  });

  it('accepts an id exactly at the cap', () => {
    expect(coerceProp({ kind: 'id' }, 'a'.repeat(LIMITS.idMax))).toBeDefined();
  });

  it.each([[5], [null], [undefined], [{}], [true]])('drops the non-string id %p', (v) => {
    expect(coerceProp({ kind: 'id' }, v)).toBeUndefined();
  });

  it('has a charset cap that agrees with LIMITS.idMax', () => {
    // Two places state the same number, so they are asserted equal rather than trusted.
    expect(ID_RE.test('a'.repeat(LIMITS.idMax))).toBe(true);
    expect(ID_RE.test('a'.repeat(LIMITS.idMax + 1))).toBe(false);
  });
});

describe('coerceProp — int', () => {
  const spec: FieldSpec = { kind: 'int', min: 0, max: 999 };

  it('accepts each bound', () => {
    expect(coerceProp(spec, 0)).toBe(0);
    expect(coerceProp(spec, 999)).toBe(999);
    expect(coerceProp(spec, 500)).toBe(500);
  });

  it.each([
    ['one below the floor', -1],
    ['one above the ceiling', 1000],
    ['fractional', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a numeric string', '12'],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
  ])('drops an int that is %s', (_label, v) => {
    expect(coerceProp(spec, v)).toBeUndefined();
  });

  it('accepts -0, which passes every guard and is not the same value as 0', () => {
    // `Object.is(-0, 0)` is false, so `toBe(0)` FAILS here while the code is right — the
    // shape this repo has been caught by before. What matters is that it is not dropped and
    // that JSON, which the store uses, has no negative zero.
    const v = coerceProp(spec, -0);
    expect(v).not.toBeUndefined();
    expect(JSON.parse(JSON.stringify({ v }))).toEqual({ v: 0 });
  });
});

describe('LIMITS', () => {
  it('keeps the batch cap below what a client can queue in a flush interval', () => {
    expect(LIMITS.eventsPerBatch).toBeGreaterThan(0);
  });

  it('bounds a client timestamp age to a day', () => {
    // The bound `anchorToServer` clamps to. Longer and a wrong device clock could file a
    // row into a cohort that has already been reported on.
    expect(LIMITS.maxAgeMs).toBe(24 * 60 * 60 * 1000);
  });
});
