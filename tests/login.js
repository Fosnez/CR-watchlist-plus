// Opens the test browser profile so you can log in to Crunchyroll once.
// The session is kept in tests/.profile (git-ignored) and reused by the tests.
const { launch, isLoggedIn } = require("./helpers");

(async () => {
  const context = await launch({ withExtension: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://www.crunchyroll.com/login");
  console.log("Log in to Crunchyroll in the window that just opened. This script exits once the session cookie appears (or after 10 minutes).");
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isLoggedIn(context)) { console.log("Logged in. Profile saved; you can close the window."); break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await context.close();
})();
