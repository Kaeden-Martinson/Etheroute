const { Router } = require('express');
const { db } = require('../config/database');
const UsageLog = require('../services/UsageLog');

const router = Router();

const PERIODS = {
  hour: { buckets: 60, stepMs: 60 * 1000 },
  day: { buckets: 24, stepMs: 60 * 60 * 1000 },
  week: { buckets: 7, stepMs: 24 * 60 * 60 * 1000 },
};

function labelFor(period, date) {
  const hh = String(date.getHours()).padStart(2, '0');
  if (period === 'hour') {
    return hh + ':' + String(date.getMinutes()).padStart(2, '0');
  }
  if (period === 'day') {
    return hh + ':00';
  }
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
}

/**
 * Usage statistics for the authenticated caller.
 *
 * Calls are bucketed by absolute timestamp range rather than by comparing
 * calendar fields, so a call made at the same hour on a different day no longer
 * lands in today's bucket.
 *
 * GET /api/api-calls/stats?period=day
 */
router.get('/stats', (req, res, next) => {
  try {
    const period = PERIODS[req.query.period] ? req.query.period : 'day';
    const { buckets, stepMs } = PERIODS[period];

    // the rows still waiting in the buffer count too
    UsageLog.flush();

    // Align the newest bucket to the current step boundary.
    const end = Math.floor(Date.now() / stepMs) * stepMs + stepMs;
    const start = end - buckets * stepMs;

    // Only the window the chart shows is read; the total is a count.
    const timestamps = db.range('apiCalls', { clientId: req.auth.clientId }, 'timestamp', { from: new Date(start).toISOString() })
      .map((call) => new Date(call.timestamp).getTime())
      .filter((time) => !Number.isNaN(time));

    const labels = [];
    const values = [];

    for (let i = buckets - 1; i >= 0; i -= 1) {
      const bucketEnd = end - i * stepMs;
      const bucketStart = bucketEnd - stepMs;
      labels.push(labelFor(period, new Date(bucketStart)));
      values.push(timestamps.filter((time) => time >= bucketStart && time < bucketEnd).length);
    }

    res.json({
      success: true,
      period,
      labels,
      values,
      periodTotal: values.reduce((sum, value) => sum + value, 0),
      totalCalls: db.countBy('apiCalls', { clientId: req.auth.clientId }),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The last requests the account made, newest first, with the figures the
 * dashboard's API page shows beside them. The log is written for every
 * authenticated call, key or session, and this is the one place it is read.
 *
 * The page polls this route while it is open, and those polls are not usage
 * anyone wants to see, so calls to the log itself are left out.
 *
 * GET /api/api-calls/recent?limit=20
 */
router.get('/recent', (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

    UsageLog.flush();
    const clientId = req.auth.clientId;
    const own = (call) => !String(call.endpoint || '').includes('/api-calls/');
    // The day's rows, newest first, for the figures; the newest few for the list.
    const day = db.range('apiCalls', { clientId }, 'timestamp', { from: new Date(dayAgo).toISOString(), newestFirst: true }).filter(own);
    const calls = day.length >= limit
      ? day
      : db.range('apiCalls', { clientId }, 'timestamp', { newestFirst: true, limit: limit * 2 }).filter(own);

    res.json({
      success: true,
      totalCalls: db.countBy('apiCalls', { clientId }),
      last24h: day.length,
      errors24h: day.filter((call) => Number(call.statusCode) >= 400).length,
      calls: calls.slice(0, limit).map((call) => ({
        method: call.method,
        endpoint: call.endpoint,
        statusCode: call.statusCode,
        timestamp: call.timestamp,
      })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
