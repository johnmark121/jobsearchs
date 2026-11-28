# Firebase setup: online play for CritterGotchi

This turns on accounts, cloud saves, leaderboards and breeding. **The game files are not edited.**
`firebase/build.mjs` copies `index.html` and `critters.html` into `dist/` and adds the config, App Check,
a self-hosted Firebase SDK and a Content Security Policy to the copies. If you skip all of this, the game
keeps working offline exactly as before.

```
index.html, critters.html   the game (unchanged, works offline)
firebase/build.mjs          builds dist/ = game + Firebase integration
firebase/config.example.json  copy to firebase/config.json (git-ignored) and fill in
firestore.rules             security rules (deny by default, validated writes)
tests/firestore.rules.test.mjs  14 rule tests, run in the emulator
firebase.json               Hosting (security headers), Firestore, emulators
.github/workflows/          CI (rule tests + build) and deploy (OIDC, no keys)
```

Requirements: Node.js 22+, Java 21+ (for the emulators), a Google account.

---

## 1. Create the Firebase project (console.firebase.google.com)

1. **Add project** → name it (e.g. `crittergotchi`). Google Analytics is not needed.
2. **Build → Authentication → Get started**
   - Sign-in method: enable **Email/Password** and **Google**.
   - Settings → **User actions**: keep **Email enumeration protection** on (stops attackers testing which emails have accounts).
   - Settings → **Password policy**: require at least 8 characters.
   - Settings → **Authorized domains**: keep only your real domains (`<project>.web.app`, `<project>.firebaseapp.com`, your custom domain). Remove `localhost` in production; the emulators don't need it.
3. **Build → Firestore Database → Create database** → **Production mode** (everything denied until you deploy the rules). Choose a location near your players; it **can't be changed later**.
4. **Project settings → Your apps → Web (`</>`)** → register an app (no Hosting checkbox needed). Copy the `firebaseConfig` values.
5. **Billing safety:** the free Spark plan is enough to start. If you upgrade to Blaze, set a **budget alert** (Google Cloud Console → Billing → Budgets) so abuse can't cost you money silently.

> **Is the config secret?** No. `apiKey`, `projectId` and `appId` are public identifiers: every visitor's browser
> receives them. Your data is protected by the **security rules**, **App Check** and the **API-key restrictions** below.
> Real secrets (service-account keys, passwords, `.env` files) must never be committed; `.gitignore` already blocks the usual names.

## 2. App Check (blocks bots and copies of your site)

> **Free option:** set `"appCheckProvider": "recaptcha-v3"` in `firebase/config.json` and create a classic **reCAPTCHA v3** key at google.com/recaptcha/admin (no billing account). The steps below are for reCAPTCHA Enterprise.

1. Google Cloud Console → **Security → reCAPTCHA** → **Create key**: type *Website*, add your domains (`<project>.web.app`, `<project>.firebaseapp.com`, your custom domain). Copy the **site key**.
2. Firebase console → **Build → App Check → Apps** → your web app → **reCAPTCHA Enterprise** → paste the site key → Save.
3. Put the same site key in `firebase/config.json` (`appCheckSiteKey`).
4. After deploying, watch **App Check → APIs** for a few days. When almost all requests show as *verified*, click **Enforce** for **Cloud Firestore** and **Authentication**. From then on, only your real site can talk to your backend.

## 3. Restrict the API key

Google Cloud Console → **APIs & Services → Credentials** → the *Browser key (auto created by Firebase)*:
- **Application restrictions → Websites:** `https://<project>.web.app/*`, `https://<project>.firebaseapp.com/*` (+ your custom domain).
- **API restrictions → Restrict key:** Identity Toolkit API, Token Service API, Cloud Firestore API, Firebase Installations API, Firebase App Check API.

Why: if someone copies the key, it only works from your domains and only for the APIs the game uses.

## 4. Local config and build

```bash
npm ci                                            # installs exact, locked versions
cp firebase/config.example.json firebase/config.json
# edit firebase/config.json: paste the values from step 1.4 and the site key from step 2
npm run build                                     # -> dist/index.html, dist/critters.html, dist/vendor/firebase-<ver>/
```

The build stops with a clear message if the config is missing or incomplete, or if the game code changed in a
way that moves one of the integration points.

## 5. Test everything locally in the emulators (no real project needed)

```bash
npm run test:rules        # 14 security-rule tests in the Firestore emulator
npm run build:emulator    # a build that talks to the local emulators
npm run emulators         # Auth + Firestore + Hosting + Emulator UI
```

Open the URL printed for **hosting** (http://127.0.0.1:5000) to play online against the local backend, and the
**Emulator UI** (http://127.0.0.1:4000) to see the accounts and documents being created. Sign up with any
made-up email: nothing leaves your machine.

## 6. First deploy (from your computer)

```bash
npx firebase login
npx firebase use --add          # pick your project, alias "default"
npm run deploy                  # build + deploy Hosting and Firestore rules/indexes
```

Your game is now live at `https://<project>.web.app`. Online features only work on your own hosting, not on the
claude.ai preview link (its sandbox blocks the Google sign-in and Firestore connections).

## 7. Automatic deploys from GitHub (OIDC, no stored keys)

GitHub Actions authenticates to Google with **Workload Identity Federation**: GitHub proves "this is the
`main` branch of johnmark121/jobsearchs" with a short-lived token, and Google trusts only that. There is no
service-account key to leak.

Run once in Cloud Shell (replace `PROJECT_ID`):

```bash
PROJECT_ID=your-project-id
REPO=johnmark121/jobsearchs
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SA=firebase-deployer@$PROJECT_ID.iam.gserviceaccount.com

gcloud iam workload-identity-pools create github --project=$PROJECT_ID --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc jobsearchs --project=$PROJECT_ID --location=global \
  --workload-identity-pool=github --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'"

gcloud iam service-accounts create firebase-deployer --project=$PROJECT_ID --display-name="GitHub deploy"
for ROLE in roles/firebasehosting.admin roles/firebaserules.admin roles/datastore.indexAdmin roles/firebase.viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role=$ROLE --condition=None
done
gcloud iam service-accounts add-iam-policy-binding $SA --project=$PROJECT_ID --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
echo "GCP_WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/jobsearchs"
echo "GCP_DEPLOY_SERVICE_ACCOUNT=$SA"
```

The deployer gets only the roles it needs (least privilege). If a deploy reports a missing permission, add only
the role it names.

Then in GitHub → **Settings → Secrets and variables → Actions → Variables** (variables, not secrets: none of these are secret):

| Variable | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | your project id |
| `FIREBASE_WEB_CONFIG` | the whole contents of `firebase/config.json`, on one line |
| `GCP_WIF_PROVIDER` | printed above |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | printed above |

And **Settings → Environments → New environment `production`** → add yourself as a *required reviewer*, so every
deploy waits for your click.

Pushing to `main` (or **Actions → Deploy to Firebase → Run workflow**) now tests the rules, builds and deploys.

## 8. Lock down the GitHub repository

- **Settings → Code security:** turn on **Secret scanning** + **Push protection**, **Dependabot alerts** + **security updates**, and **CodeQL → Default setup** (JavaScript and GitHub Actions).
- **Settings → Rules → Rulesets → New branch ruleset** for `main`: require a pull request, require the **Firebase CI / rules-and-build** status check, block force pushes and deletions.
- **Your account:** turn on **two-factor authentication** (a passkey or authenticator app, not SMS).
- `.github/dependabot.yml` opens weekly update PRs for the Firebase SDK, CLI and the pinned Actions.

---

## What protects what (in plain words)

| Protection | What it stops |
|---|---|
| Security rules (`firestore.rules`) | Players can only write their own save, profile and critter; courtship can only be answered by its recipient, once; every field is type- and size-checked; everything else is denied. |
| App Check | Scripts, bots and copied versions of your site can't use your database or sign-in. |
| API key restrictions | A copied key is useless outside your domains. |
| Content Security Policy (added by the build) | Even if someone sneaks HTML into the page, the browser refuses to run any script except the game's own (checked by its SHA-256 hash). |
| Self-hosted SDK | No third-party script CDN in the page; the deployed SDK is byte-for-byte the version that was tested. |
| Security headers (`firebase.json`) | HTTPS-only (HSTS), no framing (clickjacking), no MIME sniffing, no camera/mic/location access. |
| OIDC deploys | No long-lived Google key stored in GitHub. |

## Known limits

- **Leaderboards are best effort.** The game runs in the player's browser, so a determined cheater can still fake
  their own stats within the limits the rules allow (at most +20 catches per save for the same critter). Fully
  cheat-proof leaderboards need server-side checks (Cloud Functions).
- **Email verification, MFA and passkeys** need small changes to the game's sign-in screen (not done, to keep the game
  code unchanged). Recommended next step before a public launch.
- `npm audit` lists moderate issues in the Firebase CLI's own dependencies (dev tool only, never shipped to players).
  Dependabot will pick up fixes as they're released.
