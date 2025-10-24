const express = require('express');
const Razorpay = require('razorpay');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const qrcode = require('qrcode');
const crypto = require('crypto');
require('dotenv').config();

// --- Initialization ---

// This new code reads the key from a variable if deployed (on Render)
// or from the file if running locally.
let serviceAccount;
if (process.env.GOOGLE_CREDENTIALS) {
  // For deployment
  serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} else {
  // For local development
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const app = express();
app.use(express.json());
app.use(express.static('public'));

const TICKET_PRICE = 30; // Price *per seat*
// Get admin password from .env file, with a default fallback
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// --- API Endpoints ---

/**
 * Endpoint 1: Admin create show
 */
app.post('/api/admin/create-show', async (req, res) => {
    // UPDATED to include 'screen'
    const { name, date, screen, password } = req.body;

    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }
    // UPDATED validation
    if (!name || !date || !screen) {
        return res.status(400).json({ error: 'Name, date, and screen are required' });
    }

    try {
        const showRef = await db.collection('shows').add({
            name: name,
            date: date,
            screen: screen, // NEW field
            isActive: true,
        });
        res.status(201).json({ id: showRef.id, name: name });
    } catch (error) {
        console.error("Error creating show:", error);
        res.status(500).json({ error: 'Failed to create show' });
    }
});

/**
 * Endpoint 2: Get all active shows for users
 */
app.get('/api/get-shows', async (req, res) => {
    try {
        const showsSnapshot = await db.collection('shows')
                                    .where('isActive', '==', true)
                                    .orderBy('date', 'asc') // Show oldest first
                                    .get();
        
        const shows = showsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        res.json(shows);
    } catch (error) {
        console.error("Error fetching shows:", error);
        res.status(500).json({ error: 'Could not fetch shows' });
    }
});

/**
 * Endpoint 3: Get booked seats for a specific show
 */
app.get('/api/get-booked-seats', async (req, res) => {
    const { showId } = req.query; // Get showId from query param
    if (!showId) {
        return res.status(400).json({ error: 'Show ID is required' });
    }

    try {
        // Get the bookings subcollection for the specific show
        const bookingsRef = db.collection('shows').doc(showId).collection('bookings');

        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

        const paidSnapshot = await bookingsRef.where('status', '==', 'paid').get();
        const pendingSnapshot = await bookingsRef
                                        .where('status', '==', 'pending')
                                        .where('createdAt', '>', admin.firestore.Timestamp.fromDate(tenMinutesAgo))
                                        .get();

        let allBookedSeats = [];
        paidSnapshot.forEach(doc => allBookedSeats.push(...doc.data().seats));
        pendingSnapshot.forEach(doc => allBookedSeats.push(...doc.data().seats));

        res.json([...new Set(allBookedSeats)]);

    } catch (error) {
        console.error("Error fetching booked seats:", error);
        res.status(500).json({ error: 'Could not fetch seat data' });
    }
});

/**
 * Endpoint 4: Create a Razorpay Order
 */
app.post('/api/create-order', async (req, res) => {
  const { name, email, phone, seats, showId } = req.body; // 'showId' is now required

  if (!name || !email || !phone || !seats || seats.length === 0 || !showId) {
    return res.status(400).json({ error: 'All fields, show ID, and at least one seat are required' });
  }

  try {
    // Get the bookings subcollection for this show
    const bookingsRef = db.collection('shows').doc(showId).collection('bookings');
    
    // Check for 'paid' seats
    const paidQuery = await bookingsRef
                            .where('status', '==', 'paid')
                            .where('seats', 'array-contains-any', seats)
                            .get();
    
    if (!paidQuery.empty) {
        const takenSeat = paidQuery.docs[0].data().seats.find(s => seats.includes(s));
        return res.status(409).json({ error: `Sorry, seat ${takenSeat} is already booked. Please refresh.` });
    }

    // Check for 'pending' seats
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const pendingQuery = await bookingsRef
                               .where('status', '==', 'pending')
                               .where('seats', 'array-contains-any', seats)
                               .where('createdAt', '>', admin.firestore.Timestamp.fromDate(tenMinutesAgo))
                               .get();

    if (!pendingQuery.empty) {
        const takenSeat = pendingQuery.docs[0].data().seats.find(s => seats.includes(s));
        return res.status(409).json({ error: `Sorry, seat ${takenSeat} is currently being booked.` });
    }
    
    const totalAmount = TICKET_PRICE * seats.length;
    const options = { amount: totalAmount * 100, currency: 'INR', receipt: `receipt_${Date.now()}` };
    const razorpayOrder = await razorpay.orders.create(options);

    // Create the booking doc in the subcollection
    const bookingRef = bookingsRef.doc(); // Create new doc *inside* the show's bookings
    await bookingRef.set({
      bookingId: bookingRef.id,
      showId: showId, // Store showId for reference
      name, email, phone, seats,
      amount: totalAmount,
      razorpayOrderId: razorpayOrder.id,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      key: process.env.RAZORPAY_KEY_ID,
      orderId: razorpayOrder.id,
      bookingId: bookingRef.id, // This ID is unique
      amount: razorpayOrder.amount,
    });

  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).send('Error creating order');
  }
});

/**
 * Endpoint 5: Verify Payment
 */
app.post('/api/verify-payment', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingId, showId } = req.body;

  if (!bookingId || !showId) {
      return res.status(400).json({ error: 'Booking ID and Show ID are required.' });
  }

  const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
  shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
  const digest = shasum.digest('hex');

  if (digest !== razorpay_signature) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    // Get the specific booking doc from its show subcollection
    const bookingRef = db.collection('shows').doc(showId).collection('bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();
    
    if (!bookingDoc.exists) return res.status(404).json({ error: 'Booking not found' });
    
    const bookingData = bookingDoc.data();

    if (bookingData.status === 'paid') {
        return res.status(200).json({ message: 'This booking is already confirmed.' });
    }

    await bookingRef.update({
      status: 'paid',
      paymentId: razorpay_payment_id,
    });

    // Generate QR Code. We MUST include both showId and bookingId
   // Generate QR Code. We MUST include both showId and bookingId
const qrData = JSON.stringify({ bookingId: bookingId, showId: showId });

// NEW: URL-encode the JSON data
const encodedQrData = encodeURIComponent(qrData);

// NEW: Create a public URL for the QR code image
const qrCodeImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodedQrData}`;

console.log('Generated QR Code URL:', qrCodeImageUrl);

    // Get show info for email
    const showDoc = await db.collection('shows').doc(showId).get();
    const showName = showDoc.exists ? showDoc.data().name : 'Your Show';
    const showScreen = showDoc.exists ? showDoc.data().screen : 'N/A';

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: bookingData.email,
      subject: 'Your Movie Ticket is Confirmed!',
      html: `
        <h1>Booking Confirmed!</h1>
        <p>Hi ${bookingData.name},</p>
        <p>Thank you for your booking for <b>${showName}</b>.</p>
        <p>Please show this QR code at the event entrance.</p>
       <img src="${qrCodeImageUrl}" alt="Your QR Code Ticket">
        <hr>
        <h3>Booking Details:</h3>
        <p><b>Show:</b> ${showName}</p>
        <p><b>Screen:</b> ${showScreen}</p>
        <p><b>Seats:</b> ${bookingData.seats.join(', ')}</p>
        <p><b>Booking ID:</b> ${bookingId}</p>
      `,
    });

    res.json({ message: 'Booking successful! Check your email for the QR code.' });
  } catch (error) {
    console.error('Payment verification failed:', error);
    res.status(500).send('Error verifying payment');
  }
});

/**
 * Endpoint 6: Skip Payment (Test Booking)
 */
app.post('/api/skip-payment', async (req, res) => {
    const { name, email, phone, seats, showId } = req.body;

    if (!name || !email || !phone || !seats || seats.length === 0 || !showId) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    console.log('Attempting test booking...');

    try {
        // --- 1. Check Seat Availability (Same as create-order) ---
        const bookingsRef = db.collection('shows').doc(showId).collection('bookings');
        
        const paidQuery = await bookingsRef
                                .where('status', '==', 'paid')
                                .where('seats', 'array-contains-any', seats)
                                .get();
        
        if (!paidQuery.empty) {
            const takenSeat = paidQuery.docs[0].data().seats.find(s => seats.includes(s));
            return res.status(409).json({ error: `Sorry, seat ${takenSeat} is already booked. Please refresh.` });
        }
        
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
        const pendingQuery = await bookingsRef
                                   .where('status', '==', 'pending')
                                   .where('seats', 'array-contains-any', seats)
                                   .where('createdAt', '>', admin.firestore.Timestamp.fromDate(tenMinutesAgo))
                                   .get();

        if (!pendingQuery.empty) {
            const takenSeat = pendingQuery.docs[0].data().seats.find(s => seats.includes(s));
            return res.status(409).json({ error: `Sorry, seat ${takenSeat} is currently being booked.` });
        }

        // --- 2. Create Booking and Mark as Paid ---
        const totalAmount = TICKET_PRICE * seats.length;
        const bookingRef = bookingsRef.doc(); // Create new doc ID

        // Generate QR Code data
       // Generate QR Code data
const qrData = JSON.stringify({ bookingId: bookingRef.id, showId: showId });

// NEW: URL-encode the JSON data
const encodedQrData = encodeURIComponent(qrData);

// NEW: Create a public URL for the QR code image
const qrCodeImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodedQrData}`;

console.log('Generated QR Code URL:', qrCodeImageUrl);
        // Get Show Info
        const showDoc = await db.collection('shows').doc(showId).get();
        const showName = showDoc.exists ? showDoc.data().name : 'Your Show';
        const showScreen = showDoc.exists ? showDoc.data().screen : 'N/A';

        // --- 3. Send Email (Same as verify-payment) ---
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Your Movie Ticket is Confirmed! (TEST)',
            html: `
                <h1>Booking Confirmed! (TEST BOOKING)</h1>
                <p>Hi ${name},</p>
                <p>Thank you for your test booking for <b>${showName}</b>.</p>
                <p>Please show this QR code at the event entrance.</p>
                <img src="${qrCodeImageUrl}" alt="Your QR Code Ticket">
                <hr>
                <h3>Booking Details:</h3>
                <p><b>Show:</b> ${showName}</p>
                <p><b>Screen:</b> ${showScreen}</p>
                <p><b>Seats:</b> ${seats.join(', ')}</p>
                <p><b>Booking ID:</b> ${bookingRef.id}</p>
            `,
        });

        // --- 4. Save to Firestore (AFTER email is sent) ---
        await bookingRef.set({
            bookingId: bookingRef.id,
            showId: showId,
            name, email, phone, seats,
            amount: totalAmount,
            status: 'paid', // Mark as 'paid' immediately
            paymentId: 'TEST_MODE_SKIP', // Add a note
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Test booking successful for ${email}`);
        res.json({ message: 'Booking successful (Test Mode)! Check your email.' });

    } catch (error) {
        console.error("Error in skip-payment:", error);
        res.status(500).json({ error: 'Test booking failed on server.' });
    }
});


/**
 * Endpoint 7: Validate Ticket (Admin)
 */
app.get('/api/validate-ticket/:bookingId/:showId', async (req, res) => {
    // We now get both IDs from the QR code
    const { bookingId, showId } = req.params;
  
    try {
      const bookingRef = db.collection('shows').doc(showId).collection('bookings').doc(bookingId);
      const doc = await bookingRef.get();
  
      if (!doc.exists) {
        return res.status(404).json({ message: 'INVALID TICKET: Not found.' });
      }
  
      const bookingData = doc.data();
      
      if (bookingData.status !== 'paid') {
        return res.status(400).json({ message: 'INVALID TICKET: Payment not complete.' });
      }
  
      if (bookingData.checkedIn) {
        return res.status(409).json({ 
            message: 'ALREADY CHECKED IN', 
            name: bookingData.name,
            seats: bookingData.seats.join(', '),
            checkedInAt: bookingData.checkedInAt.toDate()
          });
      }
  
      // Mark as checked in
      await bookingRef.update({
        checkedIn: true,
        checkedInAt: admin.firestore.FieldValue.serverTimestamp()
      });
  
      res.status(200).json({ 
          message: 'VALID TICKET', 
          name: bookingData.name, 
          email: bookingData.email,
          seats: bookingData.seats.join(', ')
      });
  
    } catch (error) {
        console.error("Error validating ticket:", error);
        res.status(500).json({ message: 'Server error or invalid QR' });
    }
});


// --- Start the server ---
// --- Start the server ---
const PORT = process.env.PORT || 10000; // Use Render's port or default to 10000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});