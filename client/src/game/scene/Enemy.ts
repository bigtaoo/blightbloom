import type { DamageType } from '@dd/engine';
import { Actor } from './Actor';

// Enemy view — a plain Actor with the enemy palette. All behaviour (aiming, firing
// cadence, HP) lives in the engine now; this is only how a mob looks on screen. An
// optional `tint` overrides the body colour so elemental variants read at a glance
// (design/07/09) — the tint comes from the engine blueprint, render-only.
//
// `element` is the OTHER half of that same read (design/13's locked dual-channel law):
// the tint is the colour channel, `element` drives the icon channel — a small badge on
// the actor's health bar. Both come from the blueprint, both render-only. Undefined for
// anything that is not one of the five locked elemental variants.
export class Enemy extends Actor {
  constructor(radiusPx: number, tint?: number, boss = false, bodyRig?: string, element?: DamageType) {
    super('enemy', radiusPx, tint, boss, bodyRig, element);
  }
}
