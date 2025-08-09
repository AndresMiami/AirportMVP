# Core Business Logic

This directory contains the **core business logic** of the application.

## What belongs here:
- `pricing.js` - Pricing calculations and rules
- `booking.js` - Booking flow and state management
- `validation.js` - Business validation rules
- `config.js` - Application configuration

## Characteristics:
- Business-critical code
- Domain-specific logic
- Core application features
- Not reusable utilities

## Don't place here:
- Generic utilities (→ utils/)
- UI components
- Third-party libraries
- Alternative implementations (→ archive/)