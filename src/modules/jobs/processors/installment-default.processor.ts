import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import {
  QUEUE_INSTALLMENT_DEFAULT,
  JOB_DEFAULT_SCAN,
} from "../jobs.constants";
import { InstallmentService } from "../../installment/installment.service";

@Processor(QUEUE_INSTALLMENT_DEFAULT)
export class InstallmentDefaultProcessor {
  private readonly logger = new Logger(InstallmentDefaultProcessor.name);

  constructor(private readonly installmentService: InstallmentService) {}

  @Process(JOB_DEFAULT_SCAN)
  async runScan(_job: Job): Promise<void> {
    this.logger.log("Running daily instalment default scan");
    await this.installmentService.runDefaultScan();
  }
}
