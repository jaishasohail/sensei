import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
const ErrorBoundary = ({ error, errorInfo }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.message}>
        {error ? error.toString() : 'An unexpected error occurred'}
      </Text>
    </View>
  );
};
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FF3B30',
    marginBottom: 16,
  },
  message: {
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
  },
});
export default ErrorBoundary;
