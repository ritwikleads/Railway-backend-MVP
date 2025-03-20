const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Add required HubSpot client library
const hubspot = require('@hubspot/api-client');
// Add FormData for file uploads
const FormData = require('form-data');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Initialize HubSpot client
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_API_KEY });

// Function to call Google Solar API
async function callGoogleSolarApi(latitude, longitude, apiKey) {
  try {
    const apiUrl = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${latitude}&location.longitude=${longitude}&requiredQuality=HIGH&key=${apiKey}`;
    
    console.log(`Calling Google Solar API with URL: ${apiUrl}`);
    
    const response = await axios.get(apiUrl);
    //console.log('Google Solar API Response:', JSON.stringify(response.data, null, 2));
    
    return response.data;
  } catch (error) {
    console.error('Error calling Google Solar API:', error.message);
    if (error.response) {
      console.error('API Response Error:', error.response.data);
    }
    return null;
  }
}

// Function to download GeoTIFF file from URL
async function downloadGeoTiff(geoTiffUrl, apiKey) {
  try {
    // Extract the ID from the URL
    const idMatch = geoTiffUrl.match(/id=([^&]+)/);
    if (!idMatch || !idMatch[1]) {
      throw new Error('Invalid GeoTIFF URL format');
    }
    
    const id = idMatch[1];
    const downloadUrl = `https://solar.googleapis.com/v1/geoTiff:get?id=${id}&key=${apiKey}`;
    
    console.log(`Downloading GeoTIFF from: ${downloadUrl}`);
    
    // Set responseType to arraybuffer to get binary data
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer'
    });
  
  return {
      data: response.data,
      contentType: response.headers['content-type']
    };
  } catch (error) {
    console.error('Error downloading GeoTIFF:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
    }
    throw error;
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

// New function to create a PDF report from the processed data
async function generateSolarPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      // Create a temporary file path
      const tempFilePath = path.join(os.tmpdir(), `solar-report-${Date.now()}.pdf`);
      
      // Create a PDF document
      const doc = new PDFDocument({
        margin: 50,
        size: 'A4'
      });
      
      // Pipe the PDF to a write stream
      const stream = fs.createWriteStream(tempFilePath);
      doc.pipe(stream);
      
      // Add header
      doc.fontSize(20).text('Solar Panel Installation Report', { align: 'center' });
      doc.moveDown();
      
      // Add customer information section
      doc.fontSize(16).text('Customer Information');
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Name: ${data.userInfo.name}`);
      doc.fontSize(12).text(`Email: ${data.userInfo.email}`);
      doc.fontSize(12).text(`Phone: ${data.userInfo.phone}`);
      doc.moveDown();
      
      // Add property information section
      doc.fontSize(16).text('Property Information');
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Address: ${data.location.address}`);
      doc.fontSize(12).text(`Property Owner: ${data.propertyInfo.isOwner ? 'Yes' : 'No'}`);
      doc.fontSize(12).text(`Monthly Electricity Bill: $${data.propertyInfo.monthlyElectricityBill}`);
      doc.moveDown();
      
      // Add solar potential summary
      if (data.solarPotentialSummary) {
        doc.fontSize(16).text('Solar Potential Summary');
        doc.moveDown(0.5);
        doc.fontSize(12).text(`Maximum Capacity: ${data.solarPotentialSummary.maximumCapacity}`);
        doc.fontSize(12).text(`Available Area: ${data.solarPotentialSummary.availableArea}`);
        doc.fontSize(12).text(`Annual Sunshine: ${data.solarPotentialSummary.sunshine}`);
        doc.fontSize(12).text(`Carbon Offset: ${data.solarPotentialSummary.carbonOffset}`);
        
        // Panel specifications
        doc.moveDown(0.5);
        doc.fontSize(14).text('Panel Specifications');
        doc.fontSize(12).text(`Capacity: ${data.solarPotentialSummary.panelSpecs.capacity}`);
        doc.fontSize(12).text(`Dimensions: ${data.solarPotentialSummary.panelSpecs.dimensions}`);
        doc.fontSize(12).text(`Expected Lifetime: ${data.solarPotentialSummary.panelSpecs.lifetime}`);
        doc.moveDown();
      }
      
      // Add recommended system
      if (data.recommendedPanels) {
        doc.fontSize(16).text('Recommended System');
        doc.moveDown(0.5);
        doc.fontSize(12).text(`Recommended Panel Count: ${data.recommendedPanels} panels`);
        
        if (data.solarSystemInfo) {
          doc.fontSize(12).text(`Initial Energy Production: ${data.solarSystemInfo.initialEnergyProduction} kWh/year`);
          doc.fontSize(12).text(`Solar Coverage: ${data.solarSystemInfo.solarCoverage}%`);
          doc.fontSize(12).text(`Grid Export Percentage: ${data.solarSystemInfo.gridExportPercentage}%`);
          doc.fontSize(12).text(`Net Metering Allowed: ${data.solarSystemInfo.netMeteringAllowed ? 'Yes' : 'No'}`);
        }
        doc.moveDown();
      }
      
      // Add financing options
      if (data.financingOptions) {
        doc.fontSize(16).text('Financing Options');
        doc.moveDown(0.5);
        
        // Cash Purchase Option
        if (data.financingOptions.cashPurchase) {
          const cash = data.financingOptions.cashPurchase;
          doc.fontSize(14).text(cash.title);
          doc.fontSize(12).text(cash.description);
          doc.fontSize(12).text(`20-Year Net Savings: $${cash.netSavings20yr.toLocaleString()}`);
          doc.fontSize(12).text(`Net Cost: $${cash.netCost.toLocaleString()}`);
          doc.fontSize(12).text(`Rebate Value: $${cash.rebateValue.toLocaleString()}`);
          doc.fontSize(12).text(`Payback Period: ${cash.paybackYears} years`);
          doc.fontSize(12).text(`First Year Savings: $${cash.savingsYear1.toLocaleString()}`);
          doc.fontSize(12).text(`Property Value Increase: ${cash.propertyValueIncrease}`);
          doc.moveDown();
        }
        
        // Loan Option
        if (data.financingOptions.loan) {
          const loan = data.financingOptions.loan;
          doc.fontSize(14).text(loan.title);
          doc.fontSize(12).text(loan.description);
          doc.fontSize(12).text(`20-Year Net Savings: $${loan.netSavings20yr.toLocaleString()}`);
          doc.fontSize(12).text(`Out-of-Pocket Cost: $${loan.outOfPocketCost.toLocaleString()}`);
          doc.fontSize(12).text(`Annual Loan Payment: $${loan.annualLoanPayment.toLocaleString()}`);
          doc.fontSize(12).text(`Interest Rate: ${loan.interestRate}%`);
          doc.fontSize(12).text(`Payback: ${loan.payback}`);
          doc.fontSize(12).text(`Property Value Increase: ${loan.propertyValueIncrease}`);
          doc.moveDown();
        }
        
        // Lease Option
        if (data.financingOptions.lease) {
          const lease = data.financingOptions.lease;
          doc.fontSize(14).text(lease.title);
          doc.fontSize(12).text(lease.description);
          doc.fontSize(12).text(`20-Year Net Savings: $${lease.netSavings20yr.toLocaleString()}`);
          doc.fontSize(12).text(`Out-of-Pocket Cost: $${lease.outOfPocketCost.toLocaleString()}`);
          doc.fontSize(12).text(`Annual Leasing Cost: $${lease.annualLeasingCost.toLocaleString()}`);
          doc.fontSize(12).text(`Leases Allowed: ${lease.leasesAllowed ? 'Yes' : 'No'}`);
          doc.fontSize(12).text(`Payback: ${lease.payback}`);
          doc.moveDown();
        }
      }
      
      // Add footer
      doc.fontSize(10).text('This report was generated based on Google Solar API data.', { align: 'center' });
      doc.fontSize(10).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
      
      // Finalize the PDF
      doc.end();
      
      // When the stream is finished, resolve with the file path
      stream.on('finish', () => {
        resolve(tempFilePath);
      });
      
      stream.on('error', (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// New function to create or update a contact in HubSpot
async function createOrUpdateHubSpotContact(data) {
  try {
    const { userInfo, location, propertyInfo } = data;
    
    // Check if contact already exists
    const searchResponse = await hubspotClient.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: 'EQ',
          value: userInfo.email
        }]
      }],
      properties: ['email', 'firstname', 'lastname', 'phone'],
      limit: 1
    });
    
    let contactId;
    
    // If contact exists, get their ID
    if (searchResponse.results && searchResponse.results.length > 0) {
      contactId = searchResponse.results[0].id;
      console.log(`Found existing contact with ID: ${contactId}`);
    } else {
      // Create a new contact if none exists
      const contactProperties = {
        email: userInfo.email,
        firstname: userInfo.name.split(' ')[0],
        lastname: userInfo.name.split(' ').slice(1).join(' ') || '[Not provided]',
        phone: userInfo.phone,
        address: location.address
      };
      
      const createResponse = await hubspotClient.crm.contacts.basicApi.create({
        properties: contactProperties
      });
      
      contactId = createResponse.id;
      console.log(`Created new contact with ID: ${contactId}`);
    }
    
    // Update contact with solar data
    const solarProperties = {
      // Standard properties
      address: location.address,
      
      // Custom properties for solar data (these must be created in HubSpot first)
      solar_is_property_owner: propertyInfo.isOwner ? 'true' : 'false',
      solar_monthly_electricity_bill: propertyInfo.monthlyElectricityBill.toString(),
      solar_recommended_panels: data.recommendedPanels?.toString() || '0',
      solar_max_capacity: data.solarPotentialSummary?.maximumCapacity || 'N/A',
      solar_annual_sunshine_hours: data.solarPotentialSummary?.sunshine || 'N/A',
      
      // Financial data - select a recommended option based on viability
      solar_recommended_option: getRecommendedFinancingOption(data.financingOptions),
      solar_20yr_savings: get20YearSavings(data.financingOptions)
    };
    
    // Update the contact with solar properties
    await hubspotClient.crm.contacts.basicApi.update(contactId, {
      properties: solarProperties
    });
    
    return contactId;
  } catch (error) {
    console.error('Error creating/updating contact in HubSpot:', error);
    throw error;
  }
}

// Helper function to determine the recommended financing option
function getRecommendedFinancingOption(financingOptions) {
  if (!financingOptions) return 'None';
  
  // Check for financially viable options first
  if (financingOptions.cashPurchase?.financiallyViable) return 'Cash Purchase';
  if (financingOptions.loan?.financiallyViable) return 'Loan';
  if (financingOptions.lease?.financiallyViable) return 'Lease';
  
  // If none are viable, return the one with highest 20-year savings
  let maxSavings = -Infinity;
  let bestOption = 'None';
  
  if (financingOptions.cashPurchase?.netSavings20yr > maxSavings) {
    maxSavings = financingOptions.cashPurchase.netSavings20yr;
    bestOption = 'Cash Purchase';
  }
  
  if (financingOptions.loan?.netSavings20yr > maxSavings) {
    maxSavings = financingOptions.loan.netSavings20yr;
    bestOption = 'Loan';
  }
  
  if (financingOptions.lease?.netSavings20yr > maxSavings) {
    maxSavings = financingOptions.lease.netSavings20yr;
    bestOption = 'Lease';
  }
  
  return bestOption;
}

// Helper function to get the highest 20-year savings
function get20YearSavings(financingOptions) {
  if (!financingOptions) return '0';
  
  let maxSavings = 0;
  
  if (financingOptions.cashPurchase?.netSavings20yr > maxSavings) {
    maxSavings = financingOptions.cashPurchase.netSavings20yr;
  }
  
  if (financingOptions.loan?.netSavings20yr > maxSavings) {
    maxSavings = financingOptions.loan.netSavings20yr;
  }
  
  if (financingOptions.lease?.netSavings20yr > maxSavings) {
    maxSavings = financingOptions.lease.netSavings20yr;
  }
  
  return maxSavings.toString();
}

// FIXED: Function to upload a file to HubSpot
async function uploadFileToHubSpot(filePath, fileName, contactId) {
  try {
    // Create a form data object for file upload
    const form = new FormData();
    
    // Add the file to the form with the proper filename
    form.append('file', fs.createReadStream(filePath), {
      filename: fileName,
      contentType: 'application/pdf'
    });
    
    // Add required metadata
    form.append('fileName', fileName);
    
    // Add required folderPath parameter - create a "solar-reports" folder in HubSpot
    form.append('folderPath', '/solar-reports');
    
    // Add options
    form.append('options', JSON.stringify({
      access: 'PRIVATE',
      overwrite: true,
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'EXACT_FOLDER'
    }));
    
    // Get the API key from environment
    const apiKey = process.env.HUBSPOT_API_KEY;
    
    // Make direct API request to HubSpot
    const response = await axios.post(
      'https://api.hubapi.com/files/v3/files',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${apiKey}`
        }
      }
    );
    
    // Extract file ID and URL from response
    const fileId = response.data.id;
    let fileUrl = null;
    if (response.data && response.data.url) {
      fileUrl = response.data.url;
    }
    
    // Create a note on the contact with the file information
    try {
      // Create a note with the file information using the correct association format
      await hubspotClient.apiRequest({
        method: 'POST',
        path: '/crm/v3/objects/notes',
        body: {
          properties: {
            hs_timestamp: Date.now(),
            hs_note_body: `Solar Report PDF: ${fileName} [File ID: ${fileId}]${fileUrl ? `\n\nDownload: ${fileUrl}` : ''}`
          }
        }
      });
      
      // Now associate the note with the contact using a separate API call
      const noteSearchResponse = await hubspotClient.apiRequest({
        method: 'POST',
        path: '/crm/v3/objects/notes/search',
        body: {
          sorts: [
            {
              propertyName: "hs_timestamp",
              direction: "DESCENDING"
            }
          ],
          limit: 1,
          properties: ["hs_note_body"],
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "hs_note_body",
                  operator: "CONTAINS_TOKEN",
                  value: `${fileId}`
                }
              ]
            }
          ]
        }
      });
      
      if (noteSearchResponse.results && noteSearchResponse.results.length > 0) {
        const noteId = noteSearchResponse.results[0].id;
        
        // Associate the note with the contact
        await hubspotClient.apiRequest({
          method: 'PUT',
          path: `/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`,
        });
        
        console.log(`Successfully created and associated note with file information for contact ${contactId}`);
      } else {
        console.log('Note was created but could not be found for association');
      }
    } catch (noteError) {
      console.error('Error handling note creation/association:', noteError.message);
      console.error('Error details:', noteError);
      // Continue with the process even if note creation fails
    }
    
    // Also try to use CRM attachments API as a fallback for file association
    try {
      console.log('Attempting to create engagement with file attachment as fallback...');
      
      // Create a simple engagement with attachment
      const engagementData = {
        engagement: {
          type: 'NOTE',
          timestamp: Date.now()
        },
        associations: {
          contactIds: [contactId]
        },
        metadata: {
          body: `Solar Report Generated: ${fileName}`
        },
        attachments: [
          {
            id: fileId
          }
        ]
      };
      
      await axios({
        method: 'post',
        url: 'https://api.hubapi.com/engagements/v1/engagements',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(engagementData)
      });
      
      console.log('Successfully created engagement with file attachment');
    } catch (engagementError) {
      console.error('Error creating engagement with attachment:', engagementError.message);
      if (engagementError.response && engagementError.response.data) {
        console.error('Engagement API Error Details:', JSON.stringify(engagementError.response.data, null, 2));
      }
      // Continue even if this fails
    }
    
    return {
      fileId: fileId,
      fileUrl: fileUrl
    };
  } catch (error) {
    console.error('Error uploading file to HubSpot:', error);
    if (error.response && error.response.data) {
      console.error('HubSpot API Error Details:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

// Root endpoint for basic status check
app.get('/', (req, res) => {
  res.status(200).json({ status: 'Solar API server is running with HubSpot integration' });
});

// Main endpoint to receive form data
app.post('/', async (req, res) => {
  try {
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
    const responseData = {
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
      }
    };
    
    try {
      // Generate PDF from the processed data
      const pdfFilePath = await generateSolarPDF(responseData);
      
      // Create or update contact in HubSpot
      const contactId = await createOrUpdateHubSpotContact(responseData);
      
      // Upload PDF to HubSpot and associate with contact
      const fileName = `Solar_Report_${userInfo.name.replace(/\s+/g, '_')}_${Date.now()}.pdf`;
      const fileUploadResult = await uploadFileToHubSpot(pdfFilePath, fileName, contactId);
      
      // Clean up the temporary PDF file
      fs.unlinkSync(pdfFilePath);
      
      // Add HubSpot information to the response
      responseData.hubspot = {
        contactId: contactId,
        fileId: fileUploadResult.fileId,
        fileUrl: fileUploadResult.fileUrl,
        fileName: fileName
      };
    } catch (hubspotError) {
      console.error('Error with HubSpot integration:', hubspotError);
      // Add error information but don't fail the entire request
      responseData.hubspot = {
        error: 'Failed to integrate with HubSpot: ' + hubspotError.message
      };
    }
    
    // Return the combined response
    return res.status(200).json(responseData);
  } catch (error) {
    console.error('Error processing request:', error);
    return res.status(500).json({ 
      error: 'An error occurred while processing your request: ' + error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});

// Optional: Endpoint to download the PDF directly
app.get('/download-pdf/:contactId', async (req, res) => {
  try {
    const contactId = req.params.contactId;
    
    // Get contact details
    const contactResponse = await hubspotClient.crm.contacts.basicApi.getById(contactId);
    const contactName = (contactResponse.properties.firstname || '') + ' ' + (contactResponse.properties.lastname || '');
    
    // Get associated files
    const associationsResponse = await hubspotClient.crm.contacts.associationsApi.getAll(
      contactId,
      'file'
    );
    
    if (!associationsResponse.results || associationsResponse.results.length === 0) {
      return res.status(404).json({ error: 'No PDF report found for this contact' });
    }
    
    // Get the most recent file (assuming it's the solar report)
    const fileId = associationsResponse.results[0].id;
    
    // Get file details
    const fileResponse = await hubspotClient.files.filesApi.get(fileId);
    
    // Setup headers for download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Solar_Report_${contactName.replace(/\s+/g, '_')}.pdf"`);
    
    // Download and stream the file content
    const fileContentResponse = await axios.get(fileResponse.url, { responseType: 'stream' });
    fileContentResponse.data.pipe(res);
  } catch (error) {
    console.error('Error downloading PDF:', error);
    res.status(500).json({ error: 'Failed to download PDF report: ' + error.message });
  }
});

// Export the Express API
module.exports = app;