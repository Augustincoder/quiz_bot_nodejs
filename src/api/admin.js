const express = require('express');
const { supabase } = require('../lib/supabase');
const router = express.Router();

router.post('/upload-questions', async (req, res) => {
  const { mode, data } = req.body;

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase client not initialized' });
  }

  try {
    let result;
    switch (mode) {
      case 'brain-ring':
        result = await supabase.from('brain_ring_questions').insert(data);
        break;

      case 'zakovat':
        result = await supabase.from('zakovat_questions').insert(data);
        break;

      case 'kahoot':
        // DO NOT flatten. One row per topic block.
        const kahootRows = data.map(item => ({ topic: item.topic, questions: item.questions }));
        result = await supabase.from('kahoot_questions').insert(kahootRows);
        break;

      case 'erudit':
        // DO NOT flatten. One row per topic block.
        const eruditRows = data.map(item => ({ topic: item.topic, questions: item.questions }));
        result = await supabase.from('erudit_questions').insert(eruditRows);
        break;
        
      default:
        return res.status(400).json({ error: 'Invalid mode' });
    }

    if (result && result.error) throw result.error;
    res.json({ success: true, count: data.length });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
