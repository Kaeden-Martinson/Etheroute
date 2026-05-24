const { Router } = require('express');
const { db } = require('../config/database');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * Get API calls statistics for a user
 * GET /api/api-calls/stats
 */
router.get('/stats', (req, res, next) => {
  try {
    const { clientId, period = 'day' } = req.body;

    if (!clientId) {
      throw new ApiError(400, 'API Key or clientId is required');
    }

    const user = db.getById('users', clientId);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    // Get API calls for this user
    const allCalls = db.getAll('apiCalls') || [];
    const userCalls = allCalls.filter(call => call.clientId === clientId);

    // Generate labels and data based on period
    let labels = [];
    let values = [];
    const now = new Date();

    if (period === 'hour') {
      // Last 60 minutes
      for (let i = 59; i >= 0; i--) {
        const time = new Date(now);
        time.setMinutes(time.getMinutes() - i);
        const hour = time.getHours().toString().padStart(2, '0');
        const minute = time.getMinutes().toString().padStart(2, '0');
        labels.push(`${hour}:${minute}`);
        
        const count = userCalls.filter(call => {
          const callTime = new Date(call.timestamp);
          return callTime.getHours() === time.getHours() &&
                 callTime.getMinutes() === time.getMinutes();
        }).length;
        values.push(count);
      }
    } else if (period === 'day') {
      // Last 24 hours
      for (let i = 23; i >= 0; i--) {
        const time = new Date(now);
        time.setHours(time.getHours() - i);
        labels.push(time.getHours().toString().padStart(2, '0') + ':00');
        
        const count = userCalls.filter(call => {
          const callTime = new Date(call.timestamp);
          return callTime.getHours() === time.getHours() &&
                 callTime.getDate() === time.getDate();
        }).length;
        values.push(count);
      }
    } else if (period === 'week') {
      // Last 7 days
      for (let i = 6; i >= 0; i--) {
        const time = new Date(now);
        time.setDate(time.getDate() - i);
        const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getDay()];
        labels.push(dayName);
        
        const count = userCalls.filter(call => {
          const callTime = new Date(call.timestamp);
          return callTime.getDate() === time.getDate() &&
                 callTime.getMonth() === time.getMonth();
        }).length;
        values.push(count);
      }
    }

    res.json({
      success: true,
      period,
      labels,
      values,
      totalCalls: userCalls.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Track an API call
 * POST /api/api-calls/track
 */
router.post('/track', (req, res, next) => {
  try {
    const { endpoint, method, statusCode, clientId } = req.body;

    if (!clientId || !endpoint || !method) {
      throw new ApiError(400, 'clientId, endpoint, and method are required');
    }

    const apiCall = {
      id: require('crypto').randomUUID(),
      clientId,
      endpoint,
      method,
      statusCode: statusCode || 201,
      timestamp: new Date().toISOString()
    };

    db.create('apiCalls', apiCall);

    res.json({
      success: true,
      message: 'API call tracked'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
