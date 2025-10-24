document.addEventListener('DOMContentLoaded', () => {
    const seatMap = document.getElementById('seat-map');
    const count = document.getElementById('count');
    const total = document.getElementById('total');
    const messageEl = document.getElementById('message');
    const bookingForm = document.getElementById('booking-form');
    const showSelector = document.getElementById('show-selector'); // New

    const TICKET_PRICE = 30;
    const ROWS = 6;
    const SEATS_PER_ROW = 10;

    let bookedSeats = [];
    let currentShowId = null;

    // --- 1. Populate Show Selector ---
    // --- 1. Populate Show Selector ---
    async function populateShowSelector() {
        try {
            const res = await fetch('/api/get-shows');
            if (!res.ok) throw new Error('Could not fetch shows');
            const shows = await res.json();

            showSelector.innerHTML = ''; // Clear "Loading..."
            if (shows.length === 0) {
                showSelector.innerHTML = '<option value="">No shows available</option>';
                return;
            }

            shows.forEach(show => {
                const option = document.createElement('option');
                option.value = show.id;
                
                // UPDATED text to include the screen name
                option.textContent = `${show.name} [${show.screen}] (${new Date(show.date).toLocaleString()})`;
                
                showSelector.appendChild(option);
            });

            // Trigger change to load seats for the first show
            showSelector.dispatchEvent(new Event('change'));

        } catch (error) {
            messageEl.textContent = 'Error loading shows.';
            console.error(error);
        }
    }

    // --- 2. Handle Show Selection Change ---
    showSelector.addEventListener('change', () => {
        currentShowId = showSelector.value;
        if (currentShowId) {
            fetchBookedSeats(currentShowId);
        }
    });

    // --- 3. Create the Seat Map (no changes) ---
    function createSeatMap() {
        seatMap.innerHTML = ''; 
        for (let i = 0; i < ROWS; i++) {
            const rowLetter = String.fromCharCode(65 + i); 
            for (let j = 1; j <= SEATS_PER_ROW; j++) {
                const seat = document.createElement('div');
                const seatId = `${rowLetter}${j}`;
                seat.classList.add('seat');
                seat.dataset.seatId = seatId; 
                seat.textContent = j; 

                if (bookedSeats.includes(seatId)) {
                    seat.classList.add('sold');
                    seat.textContent = 'N/A';
                }
                seatMap.appendChild(seat);
            }
        }
        updateSelectedCount(); // Reset count on map refresh
    }

    // --- 4. Fetch Booked Seats (Now takes showId) ---
    async function fetchBookedSeats(showId) {
        if (!showId) return;
        try {
            // Pass showId as a query parameter
            const res = await fetch(`/api/get-booked-seats?showId=${showId}`);
            if (!res.ok) throw new Error('Could not fetch seats');
            bookedSeats = await res.json();
            createSeatMap(); // Create map *after* fetching
        } catch (error) {
            messageEl.textContent = 'Error loading seat map for this show.';
            console.error(error);
        }
    }

    // --- 5. Handle Seat Click Logic (no changes) ---
    seatMap.addEventListener('click', (e) => {
        const seat = e.target.closest('.seat');
        if (seat && !seat.classList.contains('sold')) {
            seat.classList.toggle('selected');
            if(seat.classList.contains('selected')) {
                seat.textContent = 'S';
            } else {
                seat.textContent = seat.dataset.seatId.substring(1);
            }
            updateSelectedCount();
        }
    });

    // --- 6. Update Count and Total (no changes) ---
    function updateSelectedCount() {
        const selectedSeats = document.querySelectorAll('.seat-map .seat.selected');
        const selectedSeatsCount = selectedSeats.length;
        count.innerText = selectedSeatsCount;
        total.innerText = selectedSeatsCount * TICKET_PRICE;
    }

    // --- 7. Handle Booking Form Submit (UPDATED) ---
    bookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = document.getElementById('name').value;
        const email = document.getElementById('email').value;
        const phone = document.getElementById('phone').value;
        
        // Get selected show ID
        const showId = showSelector.value;

        const selectedSeats = Array.from(document.querySelectorAll('.seat-map .seat.selected'))
                                  .map(seat => seat.dataset.seatId);

        if (!showId) {
            messageEl.textContent = 'Please select a show.';
            return;
        }
        if (selectedSeats.length === 0) {
            messageEl.textContent = 'Please select at least one seat.';
            return;
        }

        messageEl.textContent = 'Processing...';

        const res = await fetch('/api/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, phone, seats: selectedSeats, showId: showId }), // Pass showId
        });

        if (!res.ok) {
            const errorData = await res.json();
            messageEl.textContent = errorData.error || 'Error creating order.';
            if (res.status === 409) {
                fetchBookedSeats(showId);
            }
            return;
        }

        const data = await res.json();
        const { key, orderId, bookingId, amount } = data;

        const options = {
            key: key,
            amount: amount, 
            currency: 'INR',
            name: 'College Movie Night',
            description: `Tickets for ${selectedSeats.join(', ')}`,
            order_id: orderId,
            
            handler: async function (response) {
                messageEl.textContent = 'Verifying payment...';
                
                const verifyRes = await fetch('/api/verify-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        razorpay_payment_id: response.razorpay_payment_id,
                        razorpay_order_id: response.razorpay_order_id,
                        razorpay_signature: response.razorpay_signature,
                        bookingId: bookingId,
                        showId: showId, // Pass showId for verification
                    }),
                });

                const verifyData = await verifyRes.json();
                
                if (verifyRes.ok) {
                    messageEl.textContent = verifyData.message;
                    bookingForm.reset();
                    fetchBookedSeats(showId); 
                    updateSelectedCount();
                } else {
                    messageEl.textContent = verifyData.error || 'Payment verification failed.';
                }
            },
            prefill: { name, email, contact: phone },
            theme: { color: '#3399cc' },
        };

        const rzp = new Razorpay(options);
        
        rzp.on('payment.failed', function (response) {
            messageEl.textContent = `Payment failed: ${response.error.description}.`;
        });

        rzp.open();
    });

    // --- Initial Load ---
    populateShowSelector(); // Start by fetching shows
});