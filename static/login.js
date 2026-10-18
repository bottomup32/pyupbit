'use strict';
document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const error = document.querySelector('#error');
  error.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:document.querySelector('#password').value})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
    document.querySelector('#password').value = '';
    location.replace('/');
  } catch (failure) {
    error.textContent = failure.message;
    button.disabled = false;
  }
});
