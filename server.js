require('dotenv').config();
const express = require('express');
const path = require('path');

const signupHandler = require('./api/signup');
const loginHandler = require('./api/login');
const accountHandler = require('./api/account');
const plansHandler = require('./api/plans');
const orderRequestHandler = require('./api/order-request');
const activationCodeHandler = require('./api/activation-code');
const paymentAgentsHandler = require('./api/payment-agents');
const adminHandler = require('./api/admin');
const unsubscribeHandler = require('./api/unsubscribe');
const contactHandler = require('./api/contact');
const sendMailHandler = require('./api/send-mail');
const disabledPaymentHandler = require('./api/disabled-payment');

const app = express();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'terms.html'));
});
app.get('/payment-request', (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-request.html'));
});
app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, 'contact.html'));
});

app.use(express.urlencoded({ extended: false }), express.json());
app.post('/api/signup', signupHandler);
app.post('/api/login', loginHandler);
app.get('/api/account', accountHandler);
app.get('/api/plans', plansHandler);
app.get('/api/payment-agents', paymentAgentsHandler);
app.post('/api/order-request', orderRequestHandler);
app.post('/api/activation-code', activationCodeHandler);
app.all('/api/admin', adminHandler);
app.all('/api/unsubscribe', unsubscribeHandler);
app.post('/api/contact', contactHandler);
app.post('/api/send-mail', sendMailHandler);
app.all('/api/create-checkout-session', disabledPaymentHandler);
app.all('/api/webhook', disabledPaymentHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
