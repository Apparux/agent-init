package com.example.order;

import com.example.audit.AuditService;

public final class OrderService {
  private final AuditService auditService = new AuditService();

  public void createOrder(String actor, String orderId) {
    auditService.record(actor, "create-order", orderId);
  }

  public void cancelOrder(String actor, String orderId) {
    auditService.record(actor, "cancel-order", orderId);
  }
}
