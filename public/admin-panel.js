document.getElementById('add-show-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('show-name').value;
    const date = document.getElementById('show-date').value;
    const screen = document.getElementById('show-screen').value; // NEW
    const password = document.getElementById('admin-pass').value;
    const messageEl = document.getElementById('admin-message');

    messageEl.textContent = 'Creating...';

    const res = await fetch('/api/admin/create-show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, date, screen, password }) // UPDATED
    });

    const data = await res.json();

    if (res.ok) {
        messageEl.style.color = 'green';
        messageEl.textContent = `Success! Show "${data.name}" created with ID: ${data.id}`;
        e.target.reset();
    } else {
        messageEl.style.color = 'red';
        messageEl.textContent = `Error: ${data.error}`;
    }
});