'use strict';
const workspaceFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await workspaceFetch(...args);
  if (response.status === 401) location.replace('/login');
  return response;
};
document.querySelector('#sign-out').addEventListener('click', async () => {
  try {
    const response = await workspaceFetch('/api/auth/logout', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    if (!response.ok && response.status !== 401) throw new Error('Please try signing out again.');
    location.replace('/login');
  } catch (error) {
    alert(error.message);
  }
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
