# Utility Functions

This directory contains **reusable utility functions** that can be used across the application.

## What belongs here:
- `datetime-utils.js` - Date and time helpers
- `autocomplete.js` - Google Maps autocomplete
- `format.js` - Data formatting utilities
- `validators.js` - Generic validation helpers

## Characteristics:
- Reusable across projects
- Not business-specific
- Pure functions when possible
- Well-documented

## Don't place here:
- Business logic (→ core/)
- Application config (→ core/)
- UI components
- Test files