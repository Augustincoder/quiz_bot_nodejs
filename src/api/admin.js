'use strict';

const express = require('express');
const { supabase } = require('../lib/supabase');
const { ADMIN_ID } = require('../config/config');
const dbService = require('../services/dbService');
const router = express.Router();

/**
 * Admin authentication middleware
 */
function verifyAdminAuth(req, res, next) {
  const adminSecret = req.headers['x-admin-secret'] || req.query.admin_id;
  if (!adminSecret || String(adminSecret) !== String(ADMIN_ID)) {
    return res.status(403).json({ success: false, error: 'Forbidden: Admin access only' });
  }
  next();
}

/**
 * GET /api/admin/payments
 * Kutilayotgan to'lov so'rovlarini olish
 */
router.get('/payments', verifyAdminAuth, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'Supabase client not initialized' });
  }

  try {
    const { data: requests, error } = await supabase
      .from('payment_requests')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, count: requests ? requests.length : 0, requests });
  } catch (err) {
    console.error('GET /api/admin/payments error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/payments/:id/approve
 */
router.post('/payments/:id/approve', verifyAdminAuth, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'Supabase client not initialized' });
  }

  const reqId = req.params.id;
  try {
    const { data: payReq, error: fetchErr } = await supabase
      .from('payment_requests')
      .select('*')
      .eq('id', reqId)
      .single();

    if (fetchErr || !payReq) {
      return res.status(404).json({ success: false, error: 'To\'lov so\'rovi topilmadi' });
    }

    if (payReq.status !== 'pending') {
      return res.status(400).json({ success: false, error: `So'rov holati allaqachon ${payReq.status}` });
    }

    // DB update status -> approved
    const { error: updateErr } = await supabase
      .from('payment_requests')
      .update({
        status: 'approved',
        reviewed_by: String(ADMIN_ID),
      })
      .eq('id', reqId);

    if (updateErr) throw updateErr;

    // Activate 30 days premium
    const activated = await dbService.activatePremium(payReq.user_id, 30);

    res.json({ success: true, requestId: reqId, userId: payReq.user_id, activated });
  } catch (err) {
    console.error('POST /api/admin/payments/:id/approve error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/payments/:id/reject
 */
router.post('/payments/:id/reject', verifyAdminAuth, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'Supabase client not initialized' });
  }

  const reqId = req.params.id;
  try {
    const { error: updateErr } = await supabase
      .from('payment_requests')
      .update({
        status: 'rejected',
        reviewed_by: String(ADMIN_ID),
      })
      .eq('id', reqId);

    if (updateErr) throw updateErr;
    res.json({ success: true, requestId: reqId, status: 'rejected' });
  } catch (err) {
    console.error('POST /api/admin/payments/:id/reject error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/stats
 */
router.get('/stats', verifyAdminAuth, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'Supabase client not initialized' });
  }

  try {
    const { count: usersCount } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    const { count: premiumCount } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('is_premium', true);

    res.json({
      success: true,
      stats: {
        totalUsers: usersCount || 0,
        premiumUsers: premiumCount || 0,
      },
    });
  } catch (err) {
    console.error('GET /api/admin/stats error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
