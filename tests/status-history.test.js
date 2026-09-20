/**
 * The per-day uptime history behind the status page's tick bars.
 *
 * The page states health as one tick per day rather than a card per service, so
 * each tick has to mean something specific: a day with no recorded incident is
 * operational, a brief blip is not painted the same as an all-day outage, and
 * today is judged on the hours that have actually elapsed.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe } = require('node:test');
const assert = require('node:assert');

const StatusService = require('../src/services/StatusService');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midday on a fixed date, so "today" is half elapsed and easy to reason about. */
const NOW = new Date('2026-09-18T12:00:00.000Z');

/** An incident covering [start, end) on the day `offset` days before NOW. */
function incidentOnDay(offset, startHour, endHour) {
  const day = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()) - offset * DAY_MS);
  const at = (hour) => new Date(day.getTime() + hour * 60 * 60 * 1000).toISOString();
  return { startedAt: at(startHour), resolvedAt: endHour == null ? null : at(endHour) };
}

describe('StatusService daily history', () => {
  test('returns one entry per day in the window, oldest first', () => {
    const days = StatusService._buildDailyHistory([], NOW);

    assert.strictEqual(days.length, 30);
    assert.strictEqual(days[0].date, '2026-08-20');
    assert.strictEqual(days[29].date, '2026-09-18', 'the last entry is today');

    const dates = days.map((day) => day.date);
    assert.deepStrictEqual(dates, [...dates].sort(), 'oldest first');
  });

  test('a day with no incident is operational, not unknown', () => {
    const days = StatusService._buildDailyHistory([], NOW);

    for (const day of days) {
      assert.strictEqual(day.status, 'operational', day.date);
      assert.strictEqual(day.downtimeMinutes, 0);
      assert.strictEqual(day.uptimePercentage, 100);
    }
  });

  test('a short blip is partial; a long outage is down', () => {
    // 30 minutes out of 24h on one day, 12 hours on another.
    const days = StatusService._buildDailyHistory(
      [incidentOnDay(5, 3, 3.5), incidentOnDay(9, 6, 18)],
      NOW,
    );
    const byDate = Object.fromEntries(days.map((day) => [day.date, day]));

    const blip = byDate['2026-09-13'];
    assert.strictEqual(blip.status, 'partial');
    assert.strictEqual(blip.downtimeMinutes, 30);

    const outage = byDate['2026-09-09'];
    assert.strictEqual(outage.status, 'down');
    assert.strictEqual(outage.downtimeMinutes, 720);
    assert.strictEqual(outage.uptimePercentage, 50);
  });

  test('downtime is attributed to the day it happened, and no other', () => {
    const days = StatusService._buildDailyHistory([incidentOnDay(5, 3, 3.5)], NOW);
    const affected = days.filter((day) => day.downtimeMinutes > 0);

    assert.strictEqual(affected.length, 1);
    assert.strictEqual(affected[0].date, '2026-09-13');
  });

  test('an incident spanning midnight is split across both days', () => {
    // 22:00 to 02:00 the next morning.
    const days = StatusService._buildDailyHistory([incidentOnDay(4, 22, 26)], NOW);
    const byDate = Object.fromEntries(days.map((day) => [day.date, day]));

    assert.strictEqual(byDate['2026-09-14'].downtimeMinutes, 120, 'the first two hours');
    assert.strictEqual(byDate['2026-09-15'].downtimeMinutes, 120, 'and the two after midnight');
  });

  test('today is measured against the hours that have elapsed, not a full day', () => {
    // An hour down out of the twelve elapsed is 91.67%, not 95.83%. Judging
    // today against 24h would make every morning open near-perfect and appear
    // to degrade as the day went on.
    const days = StatusService._buildDailyHistory([incidentOnDay(0, 2, 3)], NOW);
    const today = days[days.length - 1];

    assert.strictEqual(today.date, '2026-09-18');
    assert.strictEqual(today.downtimeMinutes, 60);
    assert.strictEqual(today.uptimePercentage, 91.67);
  });

  test('an unresolved incident counts up to now and leaves the future alone', () => {
    const days = StatusService._buildDailyHistory([incidentOnDay(1, 12, null)], NOW);
    const byDate = Object.fromEntries(days.map((day) => [day.date, day]));

    assert.strictEqual(byDate['2026-09-17'].downtimeMinutes, 720, 'noon to midnight');
    assert.strictEqual(byDate['2026-09-18'].downtimeMinutes, 720, 'midnight to noon, where NOW is');
    assert.strictEqual(byDate['2026-09-18'].uptimePercentage, 0, 'and today is entirely down so far');
  });

  test('every service in a snapshot carries its history', () => {
    const snapshot = StatusService.getStatusSnapshot();

    assert.ok(snapshot.services.length > 0);
    for (const service of snapshot.services) {
      assert.strictEqual(service.days.length, snapshot.windowDays);
      for (const day of service.days) {
        assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(['operational', 'partial', 'down'].includes(day.status), day.status);
      }
    }
  });
});
