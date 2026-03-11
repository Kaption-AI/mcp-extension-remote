/** Inline HTML templates for the OTP auth flow. */

export function phoneInputPage(oauthReqInfo: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kaption MCP — Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: #171717; border: 1px solid #262626; border-radius: 12px;
      padding: 32px; max-width: 400px; width: 100%;
    }
    h1 { font-size: 20px; margin-bottom: 8px; color: #fafafa; }
    .subtitle { font-size: 14px; color: #a3a3a3; margin-bottom: 24px; line-height: 1.5; }
    label { display: block; font-size: 13px; color: #a3a3a3; margin-bottom: 6px; }
    input {
      width: 100%; padding: 10px 14px; border-radius: 8px;
      border: 1px solid #333; background: #0a0a0a; color: #fafafa;
      font-size: 16px; outline: none;
    }
    input:focus { border-color: #22c55e; }
    button {
      width: 100%; padding: 12px; border-radius: 8px; border: none;
      background: #22c55e; color: #0a0a0a; font-weight: 600;
      font-size: 14px; cursor: pointer; margin-top: 16px;
    }
    button:hover { background: #16a34a; }
    button:disabled { opacity: 0.5; cursor: wait; }
    .error { color: #ef4444; font-size: 13px; margin-top: 8px; }
    .hint { font-size: 12px; color: #737373; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Kaption MCP</h1>
    <p class="subtitle">Sign in with your WhatsApp number to connect AI tools to your conversations.</p>

    <form id="phoneForm">
      <input type="hidden" name="oauthReqInfo" value="${oauthReqInfo}" />
      <label for="phone">WhatsApp Phone Number</label>
      <input type="tel" id="phone" name="phone" placeholder="5491157390064" required autocomplete="tel" />
      <p class="hint">Enter your full number without + or spaces (e.g. 5491157390064)</p>
      ${error ? `<p class="error">${error}</p>` : ""}
      <button type="submit" id="submitBtn">Send Verification Code</button>
    </form>
  </div>

  <script>
    const form = document.getElementById('phoneForm');
    const btn = document.getElementById('submitBtn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Sending...';
      const phone = document.getElementById('phone').value.replace(/[\\s\\-\\+\\(\\)]/g, '');
      const oauthReqInfo = form.querySelector('[name=oauthReqInfo]').value;
      try {
        const res = await fetch('/authorize/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, oauthReqInfo }),
        });
        const data = await res.json();
        if (data.ok) {
          window.location.href = '/authorize/verify?phone=' + encodeURIComponent(phone) + '&oauthReqInfo=' + encodeURIComponent(oauthReqInfo);
        } else {
          btn.disabled = false;
          btn.textContent = 'Send Verification Code';
          const errEl = document.querySelector('.error');
          if (errEl) { errEl.textContent = data.error; }
          else {
            const p = document.createElement('p');
            p.className = 'error';
            p.textContent = data.error;
            form.appendChild(p);
          }
        }
      } catch {
        btn.disabled = false;
        btn.textContent = 'Send Verification Code';
      }
    });
  </script>
</body>
</html>`;
}

export function otpVerifyPage(phone: string, oauthReqInfo: string, error?: string): string {
  const maskedPhone = phone.slice(0, 3) + "****" + phone.slice(-4);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kaption MCP — Verify</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: #171717; border: 1px solid #262626; border-radius: 12px;
      padding: 32px; max-width: 400px; width: 100%;
    }
    h1 { font-size: 20px; margin-bottom: 8px; color: #fafafa; }
    .subtitle { font-size: 14px; color: #a3a3a3; margin-bottom: 24px; line-height: 1.5; }
    label { display: block; font-size: 13px; color: #a3a3a3; margin-bottom: 6px; }
    input {
      width: 100%; padding: 10px 14px; border-radius: 8px;
      border: 1px solid #333; background: #0a0a0a; color: #fafafa;
      font-size: 24px; letter-spacing: 8px; text-align: center; outline: none;
    }
    input:focus { border-color: #22c55e; }
    button {
      width: 100%; padding: 12px; border-radius: 8px; border: none;
      background: #22c55e; color: #0a0a0a; font-weight: 600;
      font-size: 14px; cursor: pointer; margin-top: 16px;
    }
    button:hover { background: #16a34a; }
    button:disabled { opacity: 0.5; cursor: wait; }
    .error { color: #ef4444; font-size: 13px; margin-top: 8px; }
    .back { display: inline-block; margin-top: 16px; color: #a3a3a3; font-size: 13px; text-decoration: none; }
    .back:hover { color: #fafafa; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Enter Verification Code</h1>
    <p class="subtitle">We sent a 6-digit code to <strong>${maskedPhone}</strong> via WhatsApp.</p>

    <form id="verifyForm">
      <input type="hidden" name="phone" value="${phone}" />
      <input type="hidden" name="oauthReqInfo" value="${oauthReqInfo}" />
      <label for="code">Verification Code</label>
      <input type="text" id="code" name="code" maxlength="6" pattern="[0-9]{6}" required autocomplete="one-time-code" inputmode="numeric" />
      ${error ? `<p class="error">${error}</p>` : ""}
      <button type="submit" id="submitBtn">Verify</button>
    </form>
    <a class="back" href="javascript:history.back()">← Use a different number</a>
  </div>

  <script>
    const form = document.getElementById('verifyForm');
    const btn = document.getElementById('submitBtn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Verifying...';
      const code = document.getElementById('code').value;
      const phone = form.querySelector('[name=phone]').value;
      const oauthReqInfo = form.querySelector('[name=oauthReqInfo]').value;
      try {
        const res = await fetch('/authorize/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, code, oauthReqInfo }),
        });
        const data = await res.json();
        if (data.redirectTo) {
          window.location.href = data.redirectTo;
        } else {
          btn.disabled = false;
          btn.textContent = 'Verify';
          const errEl = document.querySelector('.error');
          if (errEl) { errEl.textContent = data.error; }
          else {
            const p = document.createElement('p');
            p.className = 'error';
            p.textContent = data.error;
            form.appendChild(p);
          }
        }
      } catch {
        btn.disabled = false;
        btn.textContent = 'Verify';
      }
    });
  </script>
</body>
</html>`;
}

export function extensionOtpPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kaption MCP — Extension Auth</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: #171717; border: 1px solid #262626; border-radius: 12px;
      padding: 32px; max-width: 400px; width: 100%;
    }
    h1 { font-size: 20px; margin-bottom: 8px; color: #fafafa; }
    .subtitle { font-size: 14px; color: #a3a3a3; margin-bottom: 24px; line-height: 1.5; }
    label { display: block; font-size: 13px; color: #a3a3a3; margin-bottom: 6px; }
    input {
      width: 100%; padding: 10px 14px; border-radius: 8px;
      border: 1px solid #333; background: #0a0a0a; color: #fafafa;
      font-size: 16px; outline: none;
    }
    input:focus { border-color: #22c55e; }
    button {
      width: 100%; padding: 12px; border-radius: 8px; border: none;
      background: #22c55e; color: #0a0a0a; font-weight: 600;
      font-size: 14px; cursor: pointer; margin-top: 16px;
    }
    button:hover { background: #16a34a; }
    button:disabled { opacity: 0.5; cursor: wait; }
    .error { color: #ef4444; font-size: 13px; margin-top: 8px; display: none; }
    .success { color: #22c55e; font-size: 14px; margin-top: 12px; display: none; font-weight: 500; }
    .token-display {
      margin-top: 12px; padding: 12px; border-radius: 8px;
      background: #0a0a0a; border: 1px solid #262626;
      font-family: monospace; font-size: 13px; word-break: break-all;
      display: none; color: #a3a3a3;
    }
    .hint { font-size: 12px; color: #737373; margin-top: 6px; }
    #step2 { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Kaption Cloud Bridge</h1>
    <p class="subtitle">Authenticate your extension for cloud MCP relay.</p>

    <div id="step1">
      <form id="phoneForm">
        <label for="phone">WhatsApp Phone Number</label>
        <input type="tel" id="phone" name="phone" placeholder="5491157390064" required />
        <p class="hint">Enter your full number without + or spaces</p>
        <p class="error" id="phoneError"></p>
        <button type="submit" id="phoneBtn">Send Code</button>
      </form>
    </div>

    <div id="step2">
      <form id="codeForm">
        <label for="code">Verification Code</label>
        <input type="text" id="code" name="code" maxlength="6" pattern="[0-9]{6}" required inputmode="numeric" style="font-size: 24px; letter-spacing: 8px; text-align: center;" />
        <p class="error" id="codeError"></p>
        <button type="submit" id="codeBtn">Verify</button>
      </form>
    </div>

    <p class="success" id="successMsg">Connected! Copy the token below and paste it into your extension settings.</p>
    <div class="token-display" id="tokenDisplay"></div>
  </div>

  <script>
    let phone = '';
    const phoneForm = document.getElementById('phoneForm');
    const codeForm = document.getElementById('codeForm');

    phoneForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('phoneBtn');
      btn.disabled = true; btn.textContent = 'Sending...';
      phone = document.getElementById('phone').value.replace(/[\\s\\-\\+\\(\\)]/g, '');
      try {
        const res = await fetch('/ext-auth/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        });
        const data = await res.json();
        if (data.ok) {
          document.getElementById('step1').style.display = 'none';
          document.getElementById('step2').style.display = 'block';
        } else {
          document.getElementById('phoneError').style.display = 'block';
          document.getElementById('phoneError').textContent = data.error;
          btn.disabled = false; btn.textContent = 'Send Code';
        }
      } catch {
        btn.disabled = false; btn.textContent = 'Send Code';
      }
    });

    codeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('codeBtn');
      btn.disabled = true; btn.textContent = 'Verifying...';
      const code = document.getElementById('code').value;
      try {
        const res = await fetch('/ext-auth/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, code }),
        });
        const data = await res.json();
        if (data.cloud_token) {
          document.getElementById('step2').style.display = 'none';
          document.getElementById('successMsg').style.display = 'block';
          document.getElementById('tokenDisplay').style.display = 'block';
          document.getElementById('tokenDisplay').textContent = data.cloud_token;
        } else {
          document.getElementById('codeError').style.display = 'block';
          document.getElementById('codeError').textContent = data.error;
          btn.disabled = false; btn.textContent = 'Verify';
        }
      } catch {
        btn.disabled = false; btn.textContent = 'Verify';
      }
    });
  </script>
</body>
</html>`;
}
