# Deployment workflow

## Staging

Run the documented staging sequence in order:

`npm run build && npm run deploy:staging && npm run smoke:staging`

The smoke check must report a healthy `/health` endpoint before the deployment is complete. This document does not define production credentials or rollback authority.
