import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
const LoadingScreen = ({ message = 'Loading...' }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
};
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
  },
});
export default LoadingScreen;
