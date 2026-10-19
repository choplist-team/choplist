# ChopList Frontend

The frontend application for ChopList, a platform that helps local food businesses manage weekly menus, receive customer orders, and coordinate deliveries.

Overview

ChopList provides a responsive interface for sellers to set up their businesses, manage menus, and handle orders. The application is built with React and Vite, with authentication and API integration supporting the seller experience.

## Tech Stack

React — UI development

Vite — Development server and build tooling

Tailwind CSS — Styling and responsive layouts

React Router — Client-side routing

TanStack Query — Server-state management and API data fetching

Clerk — Authentication

Lucide React — Icons

Shadcn UI — Reusable UI components

# Features

Seller authentication

Seller onboarding and profile management

Seller dashboard

Menu management and publishing

Order management

Food preparation and delivery workflows

Responsive desktop and mobile navigation

Customer-facing shop and ordering experience

Features may vary depending on the current implementation and backend availability.

# Project Structure

frontend/
├── public/                 # Static assets and PWA assets
├── src/
│   ├── api/                # API client and endpoint functions
│   ├── components/         # Shared and feature-specific UI
│   │   ├── seller/         # Seller interface components
│   │   └── ui/             # Reusable UI components
│   ├── hooks/              # Custom React hooks
│   ├── pages/              # Application pages
│   ├── routes/             # Routing configuration
│   ├── App.jsx             # Application entry component
│   ├── main.jsx            # React entry point
│   └── index.css           # Global styles
├── .env.example            # Environment variable template
├── index.html
├── package.json
└── vite.config.js

## Getting Started

Prerequisites

Make sure you have the following installed:

Node.js (a version compatible with the project's dependencies)

npm

Access to the ChopList backend API

A Clerk application with a publishable key


1. Navigate to the frontend

cd choplist/frontend

2. Install dependencies

npm install

3. Configure environment variables

Create a .env file in the frontend/ directory:

VITE_API_BASE_URL=http://localhost:5000/api
VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key