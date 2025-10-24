document.addEventListener('DOMContentLoaded', () => {
    // --- Get all elements ---
    const seatMap = document.getElementById('seat-map');
    const count = document.getElementById('count');
    const total = document.getElementById('total');
    const messageEl = document.getElementById('message');
    const bookingForm = document.getElementById('booking-form');
    const showSelector = document.getElementById('show-selector');
    const skipButton = document.getElementById('skip-btn');
    const bookButton = document.getElementById('book-btn');

    // --- NEW: Timer Elements ---
    const timerContainer = document.getElementById('timer-container');
    const timerDisplay = document.getElementById('timer');
    
    let bookingTimer = null;        // Stores the interval
    let currentRzpObject = null;    // Stores the active Razorpay modal

    // --- Constants ---
    const TICKET_PRICE = 30;
    const ROWS = 6;
    const SEATS_PER_ROW = 10;

    // --- State variables ---
    let bookedSeats = [];
    let currentShowId = null;

    // --- NEW: Timer Functions ---

    function clearBookingTimer() {
        if (bookingTimer) {
            clearInterval(bookingTimer);
            bookingTimer = null;
        }
        timerContainer.classList.add('hidden'); // Hide timer
        currentRzpObject = null;
    }

    function startTimer(durationInSeconds) {
        clearBookingTimer(); // Clear any old timer

        let timer = durationInSeconds;
        timerContainer.classList.remove('hidden'); // Show timer

        bookingTimer = setInterval(function () {
            let minutes = parseInt(timer / 60, 10);
            let seconds = parseInt(timer % 60, 10);

            minutes = minutes < 10 ? "0" + minutes : minutes;
            seconds = seconds < 10 ? "0" + seconds : seconds;

            timerDisplay.textContent = minutes + ":" + seconds;

            if (--timer < 0) {
                // --- TIMER EXPIRED ---
                clearBookingTimer();
                messageEl.textContent = "Your session expired. Your seats have been released.";
                
                if (currentRzpObject) {
                    currentRzpObject.close(); // Close the Razorpay modal
                }
                
                // Refresh the map. The backend will no longer count this pending booking.
                fetchBookedSeats(currentShowId); 
            }
        }, 1000);
    }


    // --- 1. Populate Show Selector ---
    async function populateShowSelector() {
        try {
            const res = await fetch('/api/get-shows');
            if (!res.ok) throw new Error('Could not fetch shows');
            const shows = await res.json();

            showSelector.innerHTML = ''; // Clear "Loading..."
            if (shows.length === 0) {
                showSelector.innerHTML = '<option value="">No shows available</option>';
                bookButton.disabled = true;
                skipButton.disabled = true;
                return;
            }

            bookButton.disabled = false;
            skipButton.disabled = false;

            shows.forEach(show => {
                const option = document.createElement('option');
                option.value = show.id;
                option.textContent = `${show.name} [${show.screen}] (${new Date(show.date).toLocaleString()})`;
                showSelector.appendChild(option);
            });
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

    // --- 3. Create the Seat Map ---
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
        updateSelectedCount();
    }

    // --- 4. Fetch Booked Seats ---
    async function fetchBookedSeats(showId) {
        if (!showId) return;
        try {
            const res = await fetch(`/api/get-booked-seats?showId=${showId}`);
            if (!res.ok) throw new Error('Could not fetch seats');
            bookedSeats = await res.json();
            createSeatMap();
        } catch (error) {
            messageEl.textContent = 'Error loading seat map for this show.';
            console.error(error);
        }
    }

    // --- 5. Handle Seat Click Logic ---
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

    // --- 6. Update Count and Total ---
    function updateSelectedCount() {
        const selectedSeats = document.querySelectorAll('.seat-map .seat.selected');
        const selectedSeatsCount = selectedSeats.length;
        count.innerText = selectedSeatsCount;
        total.innerText = selectedSeatsCount * TICKET_PRICE;
    }

    // --- 7. Handle Booking Form Submit (Real Payment) ---
    bookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = document.getElementById('name').value;
        const email = document.getElementById('email').value;
        const phone = document.getElementById('phone').value;
        const showId = showSelector.value;
        const selectedSeats = Array.from(document.querySelectorAll('.seat-map .seat.selected'))
                                  .map(seat => seat.dataset.seatId);

        if (!showId) { messageEl.textContent = 'Please select a show.'; return; }
        if (selectedSeats.length === 0) { messageEl.textContent = 'Please select at least one seat.'; return; }

        messageEl.textContent = 'Processing...';

        const res = await fetch('/api/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, phone, seats: selectedSeats, showId: showId }),
        });

        if (!res.ok) {
            const errorData = await res.json();
            messageEl.textContent = errorData.error || 'Error creating order.';
            if (res.status === 409) { fetchBookedSeats(showId); }
            return;
        }

        const data = await res.json();
        const { key, orderId, bookingId, amount } = data;

        // --- TIMER: Start the 10-minute timer (600 seconds) ---
        startTimer(600);

        const options = {
            key: key,
            amount: amount, 
            currency: 'INR',
            name: 'College Movie Night',
            description: `Tickets for ${selectedSeats.join(', ')}`,
            order_id: orderId,
            
            handler: async function (response) {
                // --- TIMER: Stop the timer on success ---
                clearBookingTimer();
                messageEl.textContent = 'Verifying payment...';
                
                const verifyRes = await fetch('/api/verify-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        razorpay_payment_id: response.razorpay_payment_id,
                        razorpay_order_id: response.razorpay_order_id,
                        razorpay_signature: response.razorpay_signature,
                        bookingId: bookingId,
                        showId: showId,
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
            // --- TIMER: Stop the timer on failure ---
            clearBookingTimer();
            messageEl.textContent = `Payment failed: ${response.error.description}.`;
        });

        // --- TIMER: Store the modal object so our timer can close it ---
        currentRzpObject = rzp;
        rzp.open();
    });

    // --- 8. Handle Test Button Click ---
    skipButton.addEventListener('click', async (e) => {
        e.preventDefault(); 

        const name = document.getElementById('name').value;
        const email = document.getElementById('email').value;
        const phone = document.getElementById('phone').value;
        const showId = showSelector.value; 
        const selectedSeats = Array.from(document.querySelectorAll('.seat-map .seat.selected'))
                                  .map(seat => seat.dataset.seatId);

        if (!showId) { messageEl.textContent = 'Please select a show.'; return; }
        if (selectedSeats.length === 0) { messageEl.textContent = 'Please select at least one seat.'; return; }
        if (!name || !email || !phone) { messageEl.textContent = 'Please fill in all details.'; return; }

        messageEl.textContent = 'Processing Test Booking...';

        try {
            const res = await fetch('/api/skip-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, phone, seats: selectedSeats, showId: showId }),
            });
            const data = await res.json();
            if (!res.ok) { throw new Error(data.error || 'Test booking failed.'); }

            messageEl.textContent = data.message;
            bookingForm.reset();
            fetchBookedSeats(showId);
            updateSelectedCount();
        } catch (error) {
            messageEl.textContent = error.message;
            if (error.message.includes('already booked')) {
                fetchBookedSeats(showId);
            }
        }
    });

    // --- Initial Load ---
    populateShowSelector(); // Start by fetching shows
});