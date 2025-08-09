# Configuration Directory

This directory contains **configuration templates** for the project.

## Files in this directory

- ✅ `.env.example` - Environment variable template

## Files kept in root (for deployment platforms)

These files must remain in the root directory:
- `netlify.toml` - Required by Netlify in root
- `package.json` - Required by Railway in root  
- `package-lock.json` - NPM lock file
- `.gitignore` - Required by Git in root

## Environment Variables Setup

Copy `.env.example` to create your `.env` file in root:
```bash
cp config/.env.example .env
```

**Important**: The actual `.env` file should be created in the root directory, not in config/

## Guidelines
✅ Keep all config files here
✅ Document all variables
✅ Use `.example` files for templates
❌ Never commit `.env` files
❌ Don't hardcode sensitive data