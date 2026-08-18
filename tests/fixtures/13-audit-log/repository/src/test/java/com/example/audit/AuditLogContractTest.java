package com.example.audit;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

public final class AuditLogContractTest {
  @Test
  void requiredFields() {
    AuditEvent event = new AuditService().record("actor-1", "create-order", "order-1");

    assertEquals("actor-1", event.actor());
    assertEquals("create-order", event.action());
    assertEquals("order-1", event.resource());
  }
}
