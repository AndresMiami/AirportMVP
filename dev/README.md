# Development Directory

This directory contains **development-only files** that should NOT be deployed to production.

## Structure

### `admin/`
Administrative tools and dashboards
- API cost monitoring dashboard
- Admin panels
- Internal tools

### `templates/`
Business and demo templates
- Medical transport demo
- Alternative business models
- Template pages

### `tests/`
Test files and fixtures
- Unit tests
- Integration tests
- Test data

## Important
⚠️ **These files are NOT for production**
- Exclude from deployment
- May contain sensitive data
- Used for development only

## Guidelines
✅ Place experimental code here first
✅ Keep test data here
✅ Store admin tools here
❌ Don't deploy to production
❌ Don't reference from production code