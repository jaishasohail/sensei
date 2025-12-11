import { API_BASE_URL } from '../constants/config';
export const testAPIConnection = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    if (response.ok) {
      const data = await response.json();
      return { connected: true, status: data.status, database: data.database };
    }
    return { connected: false, error: 'Server responded with error' };
  } catch (error) {
    return { connected: false, error: error.message };
  }
};
export const testAuthEndpoint = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'test123' })
    });
    return { available: true, status: response.status };
  } catch (error) {
    return { available: false, error: error.message };
  }
};
export const testNavigationEndpoint = async (token) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/navigation/status`, {
      method: 'GET',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    return { available: true, status: response.status };
  } catch (error) {
    return { available: false, error: error.message };
  }
};
export const testEmergencyEndpoint = async (token) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/emergency/alerts`, {
      method: 'GET',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    return { available: true, status: response.status };
  } catch (error) {
    return { available: false, error: error.message };
  }
};
export const testAIEndpoint = async (token) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/ai/ocr`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ image: 'base64encodedimage' })
    });
    return { available: true, status: response.status };
  } catch (error) {
    return { available: false, error: error.message };
  }
};
export const runAllAPITests = async (token = null) => {
  const results = {
    health: await testAPIConnection(),
    auth: await testAuthEndpoint(),
  };
  if (token) {
    results.navigation = await testNavigationEndpoint(token);
    results.emergency = await testEmergencyEndpoint(token);
    results.ai = await testAIEndpoint(token);
  }
  return results;
};
