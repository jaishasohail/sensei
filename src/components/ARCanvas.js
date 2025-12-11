import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, PanResponder } from 'react-native';
import { GLView } from 'expo-gl';
import ARService from '../services/ARService';
export default function ARCanvas({ style, onReady, onHit }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const glRef = useRef(null);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (_, gesture) => {
        if (!size.width || !size.height) return;
        const x = gesture.x0 / size.width;
        const y = gesture.y0 / size.height;
        const hit = ARService.raycast(x, y);
        if (onHit) onHit(hit);
      },
    })
  ).current;
  const onContextCreate = useCallback(async (gl) => {
    glRef.current = gl;
    await ARService.initialize(gl, { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, pixelRatio: 1 });
    ARService.start();
    if (onReady) onReady({ gl });
  }, [onReady]);
  useEffect(() => {
    return () => {
      ARService.cleanup();
    };
  }, []);
  return (
    <View
      style={style}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize({ width, height });
      }}
      {...panResponder.panHandlers}
    >
      <GLView style={{ flex: 1 }} onContextCreate={onContextCreate} />
    </View>
  );
}
