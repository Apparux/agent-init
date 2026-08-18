package com.example.cache;

public final class CacheRepository {
  private final RedisTemplate redisTemplate = new RedisTemplate();

  public Object get(String key) {
    return redisTemplate.opsForValue().get(key);
  }

  public void put(String key, Object value) {
    redisTemplate.opsForValue().set(key, value);
  }
}
