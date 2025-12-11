# Testing and CI

## Server tests

Install dependencies and run tests:

```powershell
# In PowerShell
Push-Location "c:\Users\LAptopa\OneDrive\Desktop\sensei\server"
npm install
npm test
Pop-Location
```

## Mobile tests

This repo focuses on service-level logic. For end-to-end validation, run the Expo app and exercise features. You can add Jest for JS-only units under `src/` if desired.

## CI with GitHub Actions

A minimal workflow is included in `.github/workflows/ci.yml` to install and test the server package.
