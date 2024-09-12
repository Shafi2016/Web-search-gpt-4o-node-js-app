const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const officegen = require('officegen');
const winston = require('winston');
const { PassThrough } = require('stream');

// Load environment variables from .env or system environment
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Load and parse credentials.yml
let credentials = yaml.load(fs.readFileSync('credentials.yml', 'utf8'));

// Replace environment variables in credentials.yml
credentials.users[0].password = process.env.USER_PASSWORD;
credentials.api_keys.serpapi_key = process.env.SERPAPI_KEY;
credentials.api_keys.openai_key = process.env.OPENAI_KEY;

// Log environment variables for debugging
// console.log(`USER_PASSWORD: ${process.env.USER_PASSWORD}`);
// console.log(`SERPAPI_KEY: ${process.env.SERPAPI_KEY}`);
// console.log(`OPENAI_KEY: ${process.env.OPENAI_KEY}`);

// Middleware setup
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: credentials.api_keys.session_secret || 'fallback-secret-key',
  resave: false,
  saveUninitialized: true
}));

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
});

// Authentication middleware
const authenticate = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Routes
app.get('/', authenticate, (req, res) => {
  res.render('index', { user: req.session.user });
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  logger.info(`Login attempt for username: ${username}`);

  const user = credentials.users.find(u => u.username === username);

  if (!user) {
    logger.warn(`Login failed: User not found for username: ${username}`);
    return res.render('login', { error: 'Invalid username or password' });
  }

  try {
    const match = await bcrypt.compare(password, user.password);
    logger.info(`Password match result: ${match}`);

    if (match) {
      req.session.user = { name: user.name, username: user.username };
      logger.info(`Login successful for username: ${username}`);
      return res.redirect('/');
    } else {
      logger.warn(`Login failed: Incorrect password for username: ${username}`);
      return res.render('login', { error: 'Invalid username or password' });
    }
  } catch (error) {
    logger.error(`Error during login for username ${username}: ${error.message}`);
    return res.render('login', { error: 'An error occurred during login' });
  }
});

app.get('/logout', (req, res) => {
  const username = req.session.user ? req.session.user.username : 'Unknown';
  req.session.destroy((err) => {
    if (err) {
      logger.error(`Error during logout for user ${username}: ${err.message}`);
    } else {
      logger.info(`User ${username} logged out successfully`);
    }
    res.redirect('/login');
  });
});

// Search and analyze
app.post('/analyze', authenticate, async (req, res) => {
  try {
    const { query, question, modelChoice } = req.body;

    if (!query) {
      logger.error('Query is undefined or empty');
      return res.status(400).json({ error: 'Search query is required' });
    }

    // Search for the query using SerpAPI
    const searchResults = await searchQuery(query);

    if (!searchResults || searchResults.organic_results.length === 0) {
      logger.warn('No search results found');
      return res.status(404).json({ error: 'No search results found' });
    }

    const { context, citations } = extractRelevantInfo(searchResults);

    // Get response from OpenAI GPT model
    const answer = await askGPT(question || `Provide a comprehensive summary of the information related to: ${query}`, context, citations, modelChoice);

    const formattedAnswer = formatAnswerMarkdown(answer, citations);
    const docxBuffer = await generateDocx(answer, citations);

    logger.info(`Analysis completed successfully for query: ${query}`);
    res.json({ formattedAnswer, citations, docxBuffer: docxBuffer.toString('base64') });
  } catch (error) {
    logger.error(`Error during analysis: ${error.message}`);
    res.status(500).json({ error: `An error occurred during analysis: ${error.message}` });
  }
});

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Helper functions

// Search function to query SerpAPI
async function searchQuery(query) {
  try {
    logger.info(`Sending request to SerpAPI with query: ${query}`);
    const response = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google',
        q: query,
        api_key: credentials.api_keys.serpapi_key
      }
    });
    logger.info('SerpAPI request successful');
    return response.data;
  } catch (error) {
    logger.error(`Error during search: ${error.message}`);
    throw new Error(`Failed to perform search: ${error.message}`);
  }
}

// Extract relevant information from search results
function extractRelevantInfo(searchResults) {
  const snippets = [];
  const citations = {};

  searchResults.organic_results.forEach((result, index) => {
    if (result.snippet && result.link) {
      snippets.push(result.snippet);
      citations[`[${index + 1}]`] = result.link;
    }
  });

  const context = snippets.join(' ');
  return { context, citations };
}

// Function to query GPT model using OpenAI API (for openai@4.x.x)
async function askGPT(question, context, citations, modelChoice) {
  const openai = new OpenAI({
    apiKey: credentials.api_keys.openai_key
  });

  const fullQuestion = `${question}\n\nPlease use the following citation format when referencing sources: [1], [2], etc. The citations should correspond to the following references:\n${Object.entries(citations).map(([key, value]) => `${key}: ${value}`).join('\n')}`;

  try {
    logger.info(`Sending request to OpenAI with model: ${modelChoice}`);
    const response = await openai.chat.completions.create({
      model: modelChoice,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: fullQuestion }
      ],
      temperature: 0,
      max_tokens: 4000
    });
    logger.info('OpenAI request successful');
    return context + '\n\n' + response.choices[0].message.content;
  } catch (error) {
    logger.error(`Error during GPT query: ${error.message}`);
    throw new Error(`Failed to query GPT: ${error.message}`);
  }
}

// Function to clean and format the text
function cleanText(text) {
  // Remove excessive asterisks and periods
  text = text.replace(/\*+/g, '*').replace(/\.+/g, '.');

  // Add spaces after periods if missing
  text = text.replace(/\.(?=[A-Z])/g, '. ');

  // Remove any remaining weird characters
  text = text.replace(/[^\w\s.,;:!?*\[\]()"-]/g, '');

  return text;
}

// Function to convert citation numbers to clickable hyperlinks
function makeCitationsClickable(text, citations) {
  for (const [citation, link] of Object.entries(citations)) {
    // Replace each citation number in the format [x] with a clickable link
    const citationPattern = new RegExp(`\\${citation}`, 'g');
    text = text.replace(citationPattern, `<a href="#ref-${citation.replace(/\[|\]/g, '')}" target="_blank">${citation}</a>`);
  }
  return text;
}

// Updated function to format the answer in Markdown with clickable citations and references
function formatAnswerMarkdown(answer, citations) {
    // Clean the text
    let cleanAnswer = cleanText(answer);
  
    // Make citations clickable
    const clickableAnswer = makeCitationsClickable(cleanAnswer, citations);
  
    // Split the answer into sections
    const sections = clickableAnswer.split('\n');
  
    // Format each section
    const formattedSections = sections.map((section, index) => {
      section = section.trim();
      
      // Check if this section is a number and the next section is a heading
      if (/^\d+\.$/.test(section) && index + 1 < sections.length && /^\*.*\*$/.test(sections[index + 1])) {
        const number = section;
        const heading = sections[index + 1];
        // Combine number and heading, and skip the next section
        sections[index + 1] = '';
        return `<h3 style="color: #0066cc; font-size: 1.2em;"><strong>${number}</strong> ${heading}</h3>`;
      }
      
      // Skip empty sections (like the one we just processed above)
      if (section === '') {
        return '';
      }
      
      // Process other types of content
      if (/^\d+\.$/.test(section)) {
        // Numbered point without a following heading
        return `<p><strong>${section}</strong></p>`;
      } else if (section.startsWith('*') && section.endsWith('*')) {
        // Standalone heading (bold text)
        return `<h3 style="color: #0066cc; font-size: 1.2em;">${section}</h3>`;
      } else if (section.startsWith('-')) {
        // Bullet point
        return `<li>${section.substring(1).trim()}</li>`;
      } else {
        // Regular paragraph
        return `<p>${section}</p>`;
      }
    }).filter(section => section !== '').join('');
  
    // Prepare the references section
    const referencesSection = `
      <h2 style="color: #0066cc;">References</h2>
      <ul>
        ${Object.entries(citations).map(([citation, link]) => 
          `<li id="ref-${citation.replace(/\[|\]/g, '')}">${citation}: <a href="${link}" target="_blank">${link}</a></li>`
        ).join('')}
      </ul>
    `;
  
    // Combine everything with proper styling
    return `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        ${formattedSections}
        ${referencesSection}
      </div>
    `;
  }
// Function to generate the DOCX report
async function generateDocx(answer, citations) {
  const docx = officegen('docx');
  
  // Add a heading for the answer section
  const answerParagraph = docx.createP();
  answerParagraph.addText('Answer', { bold: true, font_face: 'Arial', font_size: 14 });

  // Split the answer into paragraphs and add to the document
  const paragraphs = answer.split('\n');
  paragraphs.forEach(paragraph => {
    const p = docx.createP();
    const parts = paragraph.split(/(\[\d+\])/);
    parts.forEach(part => {
      if (citations[part]) {
        p.addText(part, { link: citations[part] });
      } else {
        p.addText(part);
      }
    });
  });

  // Add references section
  const referencesParagraph = docx.createP();
  referencesParagraph.addText('References', { bold: true, font_face: 'Arial', font_size: 14 });
  Object.entries(citations).forEach(([citation, link]) => {
    const p = docx.createP();
    p.addText(`${citation} `);
    p.addText(link, { link: link });
  });

  // Return the document as a buffer
  return new Promise((resolve, reject) => {
    const stream = new PassThrough(); // Create a stream to capture the DOCX output
    const buffers = [];

    stream.on('data', (chunk) => buffers.push(chunk)); // Capture the data as it streams
    stream.on('end', () => resolve(Buffer.concat(buffers))); // Concatenate buffer chunks
    stream.on('error', reject); // Reject the promise if there's an error

    docx.generate(stream); // Generate the document into the stream
  });
}

// Start server
app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});
