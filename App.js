import React, { useState, useEffect } from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet, StatusBar, View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from './src/constants/theme';

import HomeScreen from './src/screens/HomeScreen';
import NavigationScreen from './src/screens/NavigationScreen';
import ARScreen from './src/screens/ARScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import EmergencyContactsScreen from './src/screens/EmergencyContactsScreen';
import AuthScreen from './src/screens/AuthScreen';
import ApiService from './src/services/ApiService';

const Tab = createBottomTabNavigator();
const SettingsStack = createNativeStackNavigator();

function SettingsStackScreen() {
  return (
    <SettingsStack.Navigator
      screenOptions={{
        headerStyle: {
          backgroundColor: COLORS.cardBackground,
        },
        headerTintColor: COLORS.text,
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
      <SettingsStack.Screen 
        name="SettingsMain" 
        component={SettingsScreen}
        options={{ headerShown: false }}
      />
      <SettingsStack.Screen 
        name="EmergencyContacts" 
        component={EmergencyContactsScreen}
        options={{ title: 'Emergency Contacts' }}
      />
    </SettingsStack.Navigator>
  );
}

const DarkNavigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: COLORS.primary,
    background: COLORS.background,
    card: COLORS.cardBackground,
    text: COLORS.text,
    border: COLORS.border,
    notification: COLORS.accent,
  },
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    initializeApp();
    
    // Check auth status periodically to handle logout
    const authCheckInterval = setInterval(() => {
      if (!ApiService.token && isAuthenticated) {
        setIsAuthenticated(false);
        setCurrentUser(null);
      }
    }, 1000);
    
    return () => clearInterval(authCheckInterval);
  }, [isAuthenticated]);

  const initializeApp = async () => {
    try {
      await ApiService.initialize();
      // Check if user has valid token
      if (ApiService.token) {
        setIsAuthenticated(true);
      }
    } catch (error) {
      console.error('App initialization error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAuthSuccess = async (token, user) => {
    await ApiService.setToken(token);
    setCurrentUser(user);
    setIsAuthenticated(true);
  };

  const handleLogout = async () => {
    await ApiService.logout();
    setIsAuthenticated(false);
    setCurrentUser(null);
  };

  if (isLoading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <GestureHandlerRootView style={styles.container}>
        <SafeAreaProvider>
          <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
          <AuthScreen onAuthSuccess={handleAuthSuccess} />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
        <NavigationContainer theme={DarkNavigationTheme}>
          <Tab.Navigator
            screenOptions={({ route }) => ({
              headerShown: true,
              tabBarIcon: ({ focused, color, size }) => {
                let iconName;
                
                if (route.name === 'Home') {
                  iconName = focused ? 'home' : 'home-outline';
                } else if (route.name === 'Navigation') {
                  iconName = focused ? 'navigate' : 'navigate-outline';
                } else if (route.name === 'AR') {
                  iconName = focused ? 'scan' : 'scan-outline';
                } else if (route.name === 'Settings') {
                  iconName = focused ? 'settings' : 'settings-outline';
                }
                
                return <Ionicons name={iconName} size={size} color={color} />;
              },
              tabBarActiveTintColor: COLORS.primary,
              tabBarInactiveTintColor: COLORS.gray,
              tabBarStyle: {
                backgroundColor: COLORS.cardBackground,
                borderTopWidth: 1,
                borderTopColor: COLORS.border,
                height: 65,
                paddingBottom: 10,
                paddingTop: 8,
              },
              tabBarLabelStyle: {
                fontSize: 12,
                fontWeight: '600',
              },
              headerStyle: {
                backgroundColor: COLORS.cardBackground,
                elevation: 0,
                shadowOpacity: 0,
                borderBottomWidth: 1,
                borderBottomColor: COLORS.border,
              },
              headerTintColor: COLORS.text,
              headerTitleStyle: {
                fontWeight: 'bold',
                fontSize: 20,
              },
            })}
          >
            <Tab.Screen 
              name="Home" 
              component={HomeScreen}
              options={{
                tabBarLabel: 'Home',
                headerTitle: 'SENSEI',
              }}
            />
            <Tab.Screen 
              name="Navigation" 
              component={NavigationScreen}
              options={{
                tabBarLabel: 'Navigate',
                headerTitle: 'Navigation',
              }}
            />
            <Tab.Screen 
              name="AR" 
              component={ARScreen}
              options={{
                tabBarLabel: 'AR View',
                headerTitle: 'AR Navigation',
              }}
            />
            <Tab.Screen 
              name="Settings" 
              component={SettingsStackScreen}
              options={{
                tabBarLabel: 'Settings',
                headerTitle: 'Settings',
                headerShown: false,
              }}
            />
          </Tab.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
});
