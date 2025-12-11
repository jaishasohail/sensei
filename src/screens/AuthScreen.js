import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, ScrollView, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Button from '../components/Button';
import Card from '../components/Card';
import TextToSpeechService from '../services/TextToSpeechService';
import ApiService from '../services/ApiService';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS } from '../constants/theme';
const AuthScreen = ({ onAuthSuccess }) => {
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const handleAuth = async () => {
    if (!email || !password) {
      const message = 'Please enter email and password';
      Alert.alert('Error', message);
      TextToSpeechService.speak(message);
      return;
    }
    if (isRegistering && password !== confirmPassword) {
      const message = 'Passwords do not match';
      Alert.alert('Error', message);
      TextToSpeechService.speak(message);
      return;
    }
    setLoading(true);
    try {
      let data;
      if (isRegistering) {
        data = await ApiService.register(email, password, name);
      } else {
        data = await ApiService.login(email, password);
      }
      
      const message = isRegistering ? 'Registration successful' : 'Login successful';
      TextToSpeechService.speak(message);
      
      if (onAuthSuccess) {
        onAuthSuccess(data.token, data.user);
      }
    } catch (error) {
      console.error('Auth error:', error);
      const errorMessage = error.message || 'Authentication failed';
      Alert.alert('Error', errorMessage);
      TextToSpeechService.speak(errorMessage);
    } finally {
      setLoading(false);
    }
  };
  const handleSocialAuth = async (provider) => {
    TextToSpeechService.speak(`${provider} authentication not yet implemented`);
    Alert.alert('Coming Soon', `${provider} authentication will be available soon`);
  };
  const toggleMode = () => {
    setIsRegistering(!isRegistering);
    const message = isRegistering ? 'Switched to login' : 'Switched to registration';
    TextToSpeechService.speak(message);
  };
  const handleForgotPassword = () => {
    TextToSpeechService.speak('Password recovery not yet implemented');
    Alert.alert('Coming Soon', 'Password recovery will be available soon');
  };
  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <LinearGradient
          colors={[COLORS.gradient1, COLORS.gradient2]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.header}
        >
          <MaterialCommunityIcons name="eye-outline" size={80} color={COLORS.text} />
          <Text style={styles.title}>SENSEI</Text>
          <Text style={styles.subtitle}>
            {isRegistering ? 'Create Your Account' : 'Welcome Back'}
          </Text>
        </LinearGradient>
        <Card variant="elevated" style={styles.formCard}>
          {isRegistering && (
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Full Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter your full name"
                placeholderTextColor={COLORS.gray}
                value={name}
                onChangeText={setName}
                accessibilityLabel="Full name input"
                accessibilityHint="Enter your full name"
              />
            </View>
          )}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your email"
              placeholderTextColor={COLORS.gray}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              accessibilityLabel="Email input"
              accessibilityHint="Enter your email address"
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your password"
              placeholderTextColor={COLORS.gray}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="Password input"
              accessibilityHint="Enter your password"
            />
          </View>
          {isRegistering && (
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Confirm Password</Text>
              <TextInput
                style={styles.input}
                placeholder="Re-enter your password"
                placeholderTextColor={COLORS.gray}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                autoCapitalize="none"
                accessibilityLabel="Confirm password input"
                accessibilityHint="Re-enter your password"
              />
            </View>
          )}
          <Button
            title={isRegistering ? 'Register' : 'Login'}
            onPress={handleAuth}
            variant="primary"
            size="large"
            fullWidth
            gradient
            loading={loading}
            icon={<Ionicons name="arrow-forward" size={20} color={COLORS.dark} />}
            style={styles.authButton}
          />
          {!isRegistering && (
            <Button
              title="Forgot Password?"
              onPress={handleForgotPassword}
              variant="ghost"
              size="small"
              fullWidth
              style={styles.forgotButton}
            />
          )}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>
          <View style={styles.socialButtons}>
            <Button
              title="Google"
              onPress={() => handleSocialAuth('Google')}
              variant="secondary"
              size="medium"
              style={styles.socialButton}
              icon={<MaterialCommunityIcons name="google" size={20} color={COLORS.text} />}
            />
            <Button
              title="Apple"
              onPress={() => handleSocialAuth('Apple')}
              variant="secondary"
              size="medium"
              style={styles.socialButton}
              icon={<MaterialCommunityIcons name="apple" size={20} color={COLORS.text} />}
            />
          </View>
          <Button
            title={isRegistering ? 'Already have an account? Login' : "Don't have an account? Register"}
            onPress={toggleMode}
            variant="ghost"
            size="medium"
            fullWidth
            style={styles.toggleButton}
          />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollContent: {
    flexGrow: 1,
    padding: SPACING.lg,
  },
  header: {
    alignItems: 'center',
    padding: SPACING.xl,
    borderRadius: BORDER_RADIUS.xl,
    marginBottom: SPACING.xl,
  },
  title: {
    fontSize: FONT_SIZES['3xl'],
    fontWeight: 'bold',
    color: COLORS.text,
    marginTop: SPACING.md,
  },
  subtitle: {
    fontSize: FONT_SIZES.lg,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  formCard: {
    padding: SPACING.xl,
  },
  inputGroup: {
    marginBottom: SPACING.lg,
  },
  label: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    marginBottom: SPACING.xs,
    fontWeight: '600',
  },
  input: {
    backgroundColor: COLORS.inputBackground,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  authButton: {
    marginTop: SPACING.md,
  },
  forgotButton: {
    marginTop: SPACING.sm,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.xl,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  dividerText: {
    marginHorizontal: SPACING.md,
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.sm,
  },
  socialButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: SPACING.md,
  },
  socialButton: {
    flex: 1,
  },
  toggleButton: {
    marginTop: SPACING.lg,
  },
});
export default AuthScreen;
