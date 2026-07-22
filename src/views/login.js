import { login } from '../lib/session.js'

export function renderLogin(onSuccess) {
  const el = document.createElement('div')
  el.className = 'login-wrap'
  el.innerHTML = `
    <form class="login-card" id="login-form">
      <h1>Nile Air Console</h1>
      <p>Enter the demo password to continue.</p>
      <div class="field">
        <label>Password</label>
        <input class="inp" type="password" id="pw" autocomplete="current-password" autofocus />
      </div>
      <button class="btn primary lg" style="width:100%" type="submit" id="go">Sign in</button>
      <div class="login-err" id="err"></div>
    </form>`

  const form = el.querySelector('#login-form')
  const err = el.querySelector('#err')
  const go = el.querySelector('#go')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    err.textContent = ''
    go.disabled = true
    go.textContent = 'Signing in…'
    try {
      await login(el.querySelector('#pw').value)
      onSuccess()
    } catch (ex) {
      err.textContent = ex.message
      go.disabled = false
      go.textContent = 'Sign in'
    }
  })
  return el
}
