const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

// Debug middleware to check if our middleware is running
app.use((req, res, next) => {
  console.log(`Received ${req.method} request to ${req.path} from origin: ${req.headers.origin}`);
  next();
});

// ===== CORS CONFIGURATION =====
// 1. Set CORS as the very first middleware (before any other middleware)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  credentials: true,
  preflightContinue: false
}));

// 2. Handle preflight requests for all routes
app.options('*', (req, res) => {
  console.log('Handling OPTIONS preflight request');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  res.sendStatus(200);
});

// 3. Add CORS headers to all responses
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

// Apply other middleware
app.use(bodyParser.json());

// Function to call Google Solar API
async function callGoogleSolarApi(latitude, longitude, apiKey) {
  try {
    const apiUrl = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${latitude}&location.longitude=${longitude}&requiredQuality=HIGH&key=${apiKey}`;
    
    console.log(`Calling Google Solar API with URL: ${apiUrl}`);
    
    const response = await axios.get(apiUrl);
    return response.data;
  } catch (error) {
    console.error('Error calling Google Solar API:', error.message);
    if (error.response) {
      console.error('API Response Error:', error.response.data);
    }
    return null;
  }
}

// Function to process Google Solar API response and extract relevant data
function processSolarApiResponse(apiResponse, userMonthlyBill) {
  if (!apiResponse || !apiResponse.solarPotential) {
    return {
      error: 'Invalid or missing solar potential data in API response'
    };
  }

  try {
    // Extract Solar Potential Summary
    const solarPotentialSummary = {
      maximumCapacity: `${apiResponse.solarPotential.maxArrayPanelsCount} panels`,
      availableArea: `${apiResponse.solarPotential.maxArrayAreaMeters2.toFixed(2)} square meters`,
      sunshine: `${apiResponse.solarPotential.maxSunshineHoursPerYear} hours per year`,
      carbonOffset: `${apiResponse.solarPotential.carbonOffsetFactorKgPerMwh.toFixed(2)} kg/MWh`,
      panelSpecs: {
        capacity: `${apiResponse.solarPotential.panelCapacityWatts} watts`,
        dimensions: `${apiResponse.solarPotential.panelHeightMeters}m × ${apiResponse.solarPotential.panelWidthMeters}m`,
        lifetime: `${apiResponse.solarPotential.panelLifetimeYears} years`
      }
    };

    // Find financial analysis closest to user's monthly bill
    let financialAnalysis = null;
    let closestBillAmount = null;
    let smallestDifference = Infinity;
    
    if (apiResponse.solarPotential.financialAnalyses && apiResponse.solarPotential.financialAnalyses.length > 0) {
      // Loop through all financial analyses to find the closest monthly bill
      for (const analysis of apiResponse.solarPotential.financialAnalyses) {
        if (analysis.monthlyBill && analysis.monthlyBill.units) {
          const billAmount = parseInt(analysis.monthlyBill.units);
          const difference = Math.abs(billAmount - userMonthlyBill);
          
          if (difference < smallestDifference) {
            smallestDifference = difference;
            financialAnalysis = analysis;
            closestBillAmount = billAmount;
          }
        }
      }
      
      // If we couldn't find a close match by bill amount, fall back to the most complete analysis
      if (!financialAnalysis) {
        // Find the first financial analysis that has all three financing options
        financialAnalysis = apiResponse.solarPotential.financialAnalyses.find(
          analysis => analysis.cashPurchaseSavings && analysis.financedPurchaseSavings && analysis.leasingSavings
        );

        // If we didn't find one with all three, take the first one that has any financing data
        if (!financialAnalysis) {
          financialAnalysis = apiResponse.solarPotential.financialAnalyses.find(
            analysis => analysis.cashPurchaseSavings || analysis.financedPurchaseSavings || analysis.leasingSavings
          );
        }
      }
    }

    if (!financialAnalysis) {
      return {
        solarPotentialSummary,
        financingOptions: {
          error: 'No financial analysis data available'
        }
      };
    }

    // Extract financing options
    const financingOptions = {};

    // 1. Cash Purchase (if available)
    if (financialAnalysis.cashPurchaseSavings) {
      const cash = financialAnalysis.cashPurchaseSavings;
      financingOptions.cashPurchase = {
        title: 'PAY CASH',
        description: 'Own the system; maximize savings',
        netSavings20yr: parseInt(cash.savings.savingsYear20?.units || 0),
        netCost: parseInt(cash.upfrontCost?.units || 0),
        rebateValue: parseInt(cash.rebateValue?.units || 0),
        paybackYears: cash.paybackYears || 0,
        financiallyViable: cash.savings.financiallyViable || false,
        savingsYear1: parseInt(cash.savings.savingsYear1?.units || 0),
        propertyValueIncrease: "3% or more" // Standard industry assumption
      };
    }

    // 2. Financed Purchase / Loan (if available)
    if (financialAnalysis.financedPurchaseSavings) {
      const loan = financialAnalysis.financedPurchaseSavings;
      financingOptions.loan = {
        title: '$0-DOWN LOAN',
        description: 'Own the system; no up-front cost',
        netSavings20yr: parseInt(loan.savings.savingsYear20?.units || 0),
        outOfPocketCost: 0, // Zero down loan
        annualLoanPayment: parseInt(loan.annualLoanPayment?.units || 0),
        interestRate: loan.loanInterestRate || 0,
        financiallyViable: loan.savings.financiallyViable || false,
        payback: "Immediate", // As shown in UI
        propertyValueIncrease: "3% or more" // Standard industry assumption
      };
    }

    // 3. Leasing (if available)
    if (financialAnalysis.leasingSavings) {
      const lease = financialAnalysis.leasingSavings;
      financingOptions.lease = {
        title: '$0-DOWN LEASE/PPA',
        description: 'Rent the system; no up-front cost',
        netSavings20yr: parseInt(lease.savings.savingsYear20?.units || 0),
        outOfPocketCost: 0, // Zero down lease
        annualLeasingCost: parseInt(lease.annualLeasingCost?.units || 0),
        leasesAllowed: lease.leasesAllowed || false,
        financiallyViable: lease.savings.financiallyViable || false,
        payback: "Immediate", // As shown in UI
        propertyValueIncrease: "0%" // Leased systems typically don't add property value
      };
    }

    // Additional context about the solar system
    let solarSystemInfo = {};
    if (financialAnalysis.financialDetails) {
      const details = financialAnalysis.financialDetails;
      solarSystemInfo = {
        initialEnergyProduction: details.initialAcKwhPerYear,
        solarCoverage: details.solarPercentage,
        gridExportPercentage: details.percentageExportedToGrid,
        netMeteringAllowed: details.netMeteringAllowed,
        utilityBillWithoutSolar: parseInt(details.costOfElectricityWithoutSolar?.units || 0)
      };
    }

    // Get recommended panel count if available
    let recommendedPanels = 0;
    if (financialAnalysis.panelConfigIndex >= 0 && 
        apiResponse.solarPotential.solarPanelConfigs && 
        apiResponse.solarPotential.solarPanelConfigs[financialAnalysis.panelConfigIndex]) {
      recommendedPanels = apiResponse.solarPotential.solarPanelConfigs[financialAnalysis.panelConfigIndex].panelsCount;
    }

    return {
      solarPotentialSummary,
      financingOptions,
      solarSystemInfo,
      recommendedPanels,
      electricityBillInfo: {
        userMonthlyBill: userMonthlyBill,
        closestAnalyzedBill: closestBillAmount
      }
    };
  } catch (error) {
    console.error('Error processing Solar API response:', error);
    return {
      error: 'Error processing Solar API response: ' + error.message,
      rawData: apiResponse // Include raw data for debugging
    };
  }
}

// Function to send data to the n8n webhook
async function sendToN8nWebhook(data, webhookUrl) {
  try {
    console.log(`Sending data to n8n webhook: ${webhookUrl}`);
    
    const response = await axios.post(webhookUrl, data);
    
    console.log('n8n webhook response status:', response.status);
    
    return {
      success: true,
      statusCode: response.status
    };
  } catch (error) {
    console.error('Error sending data to n8n webhook:', error.message);
    if (error.response) {
      console.error('Webhook Response Error:', error.response.status);
      console.error('Webhook Response Data:', error.response.data);
    }
    return {
      success: false,
      error: error.message,
      statusCode: error.response?.status
    };
  }
}

// Root endpoint for basic status check
app.get('/', (req, res) => {
  // Add CORS headers explicitly for this endpoint
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  res.status(200).json({ status: 'Solar API server is running' });
});

// Main endpoint to receive form data
app.post('/', async (req, res) => {
  try {
    // Add CORS headers explicitly for this endpoint
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    console.log('Received data:', JSON.stringify(req.body, null, 2));
    
    // Validate request body
    const { userInfo, location, propertyInfo } = req.body;
    
    if (!userInfo || !location || !propertyInfo) {
      return res.status(400).json({ 
        error: 'Missing required data. Please ensure userInfo, location, and propertyInfo are provided.' 
      });
    }
    
    if (!location.latitude || !location.longitude) {
      return res.status(400).json({ 
        error: 'Missing location coordinates. Please ensure latitude and longitude are provided.' 
      });
    }
    
    // Extract and validate monthly electricity bill
    const monthlyElectricityBill = propertyInfo?.monthlyElectricityBill 
      ? parseFloat(propertyInfo.monthlyElectricityBill) 
      : 0;
      
    if (isNaN(monthlyElectricityBill)) {
      return res.status(400).json({
        error: 'Invalid monthly electricity bill amount'
      });
    }
    
    // Your Google API Key
    const googleApiKey = process.env.GOOGLE_API_KEY;
    
    if (!googleApiKey) {
      return res.status(500).json({
        error: 'Google API key is not configured'
      });
    }

    // Get the n8n webhook URL from environment variables
    const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
    
    if (!n8nWebhookUrl) {
      console.warn('N8N webhook URL is not configured. Data will not be sent to n8n.');
    }
    
    // Call Google Solar API for building insights
    const buildingInsightsResponse = await callGoogleSolarApi(
      location.latitude, 
      location.longitude,
      googleApiKey
    );
    
    if (!buildingInsightsResponse) {
      return res.status(500).json({
        error: 'Failed to retrieve data from Google Solar API'
      });
    }
    
    // Process the building insights API response
    const processedData = processSolarApiResponse(buildingInsightsResponse, monthlyElectricityBill);
    
    // Combine all data into a single response
    const combinedData = {
      // Solar calculation results
      ...processedData,
      
      // User information
      userInfo: {
        name: userInfo.name,
        phone: userInfo.phone,
        email: userInfo.email
      },
      
      // Location information
      location: {
        address: location.address,
        latitude: location.latitude,
        longitude: location.longitude
      },
      
      // Property information
      propertyInfo: {
        isOwner: propertyInfo.isOwner,
        monthlyElectricityBill: monthlyElectricityBill
      },
      
      // Add timestamp
      timestamp: new Date().toISOString()
    };
    
    // Send the combined data to the n8n webhook if configured
    let webhookResult = null;
    if (n8nWebhookUrl) {
      webhookResult = await sendToN8nWebhook(combinedData, n8nWebhookUrl);
      
      // Add webhook result to the response
      combinedData.webhookResult = webhookResult;
    } else {
      combinedData.webhookResult = {
        success: false,
        error: 'N8N webhook URL not configured'
      };
    }
    
    // Return the combined response
    return res.status(200).json(combinedData);
  } catch (error) {
    console.error('Error processing request:', error);
    return res.status(500).json({ 
      error: 'An error occurred while processing your request: ' + error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  // Add CORS headers explicitly for this endpoint
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  res.status(200).send('Server is running');
});

// Listen on the port assigned by Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Export the Express API
module.exports = app;