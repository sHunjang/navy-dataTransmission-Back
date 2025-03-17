const express = require('express');
const router = express.Router();
const fileController = require('../controllers/fileController');

router.post('/send-single', fileController.sendSingleThread);
router.post('/send-multiple', fileController.sendMultipleThread);

module.exports = router;