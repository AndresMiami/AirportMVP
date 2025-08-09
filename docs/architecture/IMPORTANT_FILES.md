# Important Project Files Documentation

## Core Business Assets

### 1. Medical_transport_demo.html (60KB)
**Purpose**: Business pivot template for transportation services
**Importance**: CRITICAL - Do not delete
**Description**: 
- Complete medical transportation booking system template
- Demonstrates the flexibility of the transportation platform
- Can be adapted for different industries (medical, corporate, school transport)
- Contains reusable UI components and booking flow
- Foundation for potential business model pivots

**Key Features**:
- Multi-step booking process
- Payment method selection (Medicaid, Insurance, Self-pay)
- Recurring appointment scheduling
- Wheelchair accessible vehicle options
- Return trip booking functionality

### 2. api-cost-dashboard.html (40KB)
**Purpose**: API usage monitoring and cost tracking dashboard
**Importance**: CRITICAL - Do not delete
**Description**:
- Visualizes API request patterns and costs
- Essential for monitoring Google Maps API usage
- Helps track and optimize API expenses
- Will be connected to live API request data
- Important for business intelligence and cost management

**Key Features**:
- Real-time API call tracking
- Cost breakdown by API type
- Usage trends visualization
- Budget alerts and monitoring
- Historical data analysis

## Recommended Project Structure

```
/AirportMVP
├── /production              # Main production files
│   ├── indexMVP.html       # Airport transfer booking app
│   ├── Driver.html         # Driver interface
│   ├── Passenger.html      # Passenger tracking
│   └── LandingLOGIN.html   # Login page
│
├── /business-templates      # Business model templates
│   └── Medical_transport_demo.html
│
├── /admin-tools            # Administrative tools
│   └── api-cost-dashboard.html
│
├── /src                    # Source code
│   ├── /js
│   ├── /css
│   └── /images
│
└── /netlify               # Serverless functions
```

## Notes for Team

- **Medical_transport_demo.html**: Keep this as a reference for expanding into medical transportation or other verticals. The booking flow and UI patterns are reusable.

- **api-cost-dashboard.html**: This needs to be connected to actual API tracking. Consider adding:
  - Supabase integration for storing API call logs
  - Real-time updates via WebSocket
  - Export functionality for accounting purposes
  - Budget threshold alerts

## Future Enhancements

1. **For Medical Transport Template**:
   - Extract reusable components
   - Create a component library
   - Document the adaptation process for other industries

2. **For API Dashboard**:
   - Implement real-time data connection
   - Add authentication for admin access
   - Create API cost predictions
   - Set up automated alerts for unusual usage

---
*Last Updated: August 2025*
*Do not delete these files without team discussion*