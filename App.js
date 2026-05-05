import React, { useState, useEffect, useRef } from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  StyleSheet,
  StatusBar,
  View,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from './src/constants/theme';

import HomeScreen from './src/screens/HomeScreen';
import NavigationScreen from './src/screens/NavigationScreen';
import ARScreen from './src/screens/ARScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import EmergencyContactsScreen from './src/screens/EmergencyContactsScreen';
import EmotionDetectionScreen from './src/screens/EmotionDetectionScreen';
import AuthScreen from './src/screens/AuthScreen';
import ApiService from './src/services/ApiService';
import VoiceCommandService from './src/services/VoiceCommandService';
import TextToSpeechService from './src/services/TextToSpeechService';

const Tab        = createBottomTabNavigator();
const RootStack  = createNativeStackNavigator();   // top-level: tabs + modal screens
const SettingsStack = createNativeStackNavigator();

function SettingsStackScreen() {
  return (
    <SettingsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.cardBackground },
        headerTintColor: COLORS.text,
        headerTitleStyle: { fontWeight: 'bold' },
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

// ── Bottom tab navigator (the app's main navigation) ─────────────────────────
function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        tabBarIcon: ({ focused, color, size }) => {
          let iconName;
          if      (route.name === 'Home')       iconName = focused ? 'home'     : 'home-outline';
          else if (route.name === 'Navigation') iconName = focused ? 'navigate' : 'navigate-outline';
          else if (route.name === 'AR')         iconName = focused ? 'scan'     : 'scan-outline';
          else if (route.name === 'Settings')   iconName = focused ? 'settings' : 'settings-outline';
          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor:   COLORS.primary,
        tabBarInactiveTintColor: COLORS.gray,
        tabBarStyle: {
          backgroundColor: COLORS.cardBackground,
          borderTopWidth:  1,
          borderTopColor:  COLORS.border,
          height:          65,
          paddingBottom:   10,
          paddingTop:      8,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        headerStyle: {
          backgroundColor: COLORS.cardBackground,
          elevation:        0,
          shadowOpacity:    0,
          borderBottomWidth: 1,
          borderBottomColor: COLORS.border,
        },
        headerTintColor:      COLORS.text,
        headerTitleStyle:     { fontWeight: 'bold', fontSize: 20 },
      })}
    >
      <Tab.Screen name="Home"       component={HomeScreen}          options={{ tabBarLabel: 'Home',     headerTitle: 'SENSEI' }} />
      <Tab.Screen name="Navigation" component={NavigationScreen}    options={{ tabBarLabel: 'Navigate', headerTitle: 'Navigation' }} />
      <Tab.Screen name="AR"         component={ARScreen}            options={{ tabBarLabel: 'AR View',  headerTitle: 'AR Navigation' }} />
      <Tab.Screen name="Settings"   component={SettingsStackScreen} options={{ tabBarLabel: 'Settings', headerTitle: 'Settings', headerShown: false }} />
    </Tab.Navigator>
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

// ── Mic status colours ────────────────────────────────────────────────────────
const MIC_COLORS = {
  idle:       COLORS.gray,
  wake:       '#4A4A4A',          // dim — passively waiting for wake word
  listening:  COLORS.primary,    // bright — active command mode
  processing: COLORS.warning,
  error:      COLORS.danger,
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading]             = useState(true);
  const [currentUser, setCurrentUser]         = useState(null);

  // Always-on voice status
  const [voiceStatus, setVoiceStatus]     = useState('idle');   // 'idle'|'listening'|'processing'|'error'
  const [lastTranscript, setLastTranscript] = useState('');

  const navigationRef = useRef(null);
  const pulseAnim     = useRef(new Animated.Value(1)).current;
  const pulseLoop     = useRef(null);

  // ── Pulse animation: only pulse in active-command (listening) mode ──────
  useEffect(() => {
    if (voiceStatus === 'listening') {
      pulseLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.25, duration: 700, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1.00, duration: 700, useNativeDriver: true }),
        ])
      );
      pulseLoop.current.start();
    } else {
      if (pulseLoop.current) {
        pulseLoop.current.stop();
        pulseLoop.current = null;
      }
      Animated.timing(pulseAnim, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    }
  }, [voiceStatus]);

  // ── App init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    initializeApp();

    const authCheckInterval = setInterval(() => {
      if (!ApiService.token && isAuthenticated) {
        setIsAuthenticated(false);
        setCurrentUser(null);
      }
    }, 1000);

    return () => clearInterval(authCheckInterval);
  }, [isAuthenticated]);

  // ── Start wake-word listener once authenticated; announce to user ────────
  useEffect(() => {
    if (!isAuthenticated) return;

    VoiceCommandService.setNavigationRef(navigationRef);

    // Tell the user how to activate — runs once after login
    TextToSpeechService.speak("Say Hey Sensei to activate voice commands");

    VoiceCommandService.startContinuousListening((status, transcript) => {
      setVoiceStatus(status);
      if (transcript) setLastTranscript(transcript);
    });

    return () => {
      VoiceCommandService.stopContinuousListening();
      setVoiceStatus('idle');
    };
  }, [isAuthenticated]);

  const initializeApp = async () => {
    try {
      await ApiService.initialize();
      if (ApiService.token) setIsAuthenticated(true);
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

  // ── Loading splash ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  // ── Auth gate ─────────────────────────────────────────────────────────────
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

  // ── Icon for current voice status ─────────────────────────────────────────
  const micIcon =
    voiceStatus === 'error'      ? 'mic-off'         :
    voiceStatus === 'processing' ? 'hourglass-outline':
    voiceStatus === 'wake'       ? 'mic-outline'      :   // passive — outlined
    'mic';                                                 // active — filled

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />

        <NavigationContainer ref={navigationRef} theme={DarkNavigationTheme}>
          {/*
           * Root stack — allows any screen to push EmotionDetection (or future
           * modal screens) on top of the bottom tabs without the tab bar showing.
           */}
          <RootStack.Navigator screenOptions={{ headerShown: false }}>
            {/* Main tab navigator — registered as the first (default) screen */}
            <RootStack.Screen name="MainTabs" component={MainTabs} />

            {/* Emotion detection — full-screen camera modal */}
            <RootStack.Screen
              name="EmotionDetection"
              component={EmotionDetectionScreen}
              options={{
                headerShown:      true,
                title:            'Emotion Detection',
                headerStyle:      { backgroundColor: COLORS.cardBackground },
                headerTintColor:  COLORS.text,
                headerTitleStyle: { fontWeight: 'bold' },
                animation:        'slide_from_bottom',
              }}
            />
          </RootStack.Navigator>
        </NavigationContainer>

        {/* Always-on voice indicator — no button press needed */}
        <Animated.View
          style={[
            styles.micIndicator,
            {
              backgroundColor: MIC_COLORS[voiceStatus] || COLORS.gray,
              transform: [{ scale: pulseAnim }],
            },
          ]}
          accessibilityLabel={`Voice status: ${voiceStatus}`}
          pointerEvents="none"
        >
          <Ionicons name={micIcon} size={22} color={COLORS.white} />
        </Animated.View>

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
  micIndicator: {
    position:      'absolute',
    bottom:        90,
    right:         20,
    width:         52,
    height:        52,
    borderRadius:  26,
    justifyContent: 'center',
    alignItems:    'center',
    elevation:     6,
    shadowColor:   '#000',
    shadowOffset:  { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius:  4,
  },
});
