const form = document.getElementById("loginForm");
const passwordInput = document.getElementById("passwordInput");
const rememberInput = document.getElementById("rememberInput");
const loginButton = document.getElementById("loginButton");
const loginError = document.getElementById("loginError");

async function handleLogin(event) {
  event.preventDefault();

  loginError.textContent = "";
  loginButton.disabled = true;

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        password: passwordInput.value,
        rememberMe: rememberInput.checked,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Login failed");
    }

    window.location.href = "/chatdrop";
  } catch (error) {
    loginError.textContent = error.message || "Login failed";
  } finally {
    loginButton.disabled = false;
  }
}

form.addEventListener("submit", handleLogin);
