/**
 * ============================================
 * DATE/TIME UTILITIES MODULE
 * ============================================
 * 
 * Handles all date and time selection functionality:
 * - Date selection (Today/Tomorrow/Calendar)
 * - Time selection with validation
 * - Calendar rendering and navigation
 * - Time formatting and constraints
 */

export class DateTimeManager {
    constructor(els, state, callbacks) {
        this.els = els;
        this.state = state;
        this.callbacks = callbacks;
        this.calendarState = null;
    }

    initializeDateTime() {
        this.initializeDateSelection();
        this.populateTimeOptions();
        this.setDefaultDateTime();
    }

    initializeDateSelection() {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        
        document.getElementById('todayDate').textContent = this.formatDateShort(today);
        document.getElementById('tomorrowDate').textContent = this.formatDateShort(tomorrow);
        
        document.getElementById('todayBtn').dataset.date = today.toISOString();
        document.getElementById('tomorrowBtn').dataset.date = tomorrow.toISOString();
        
        document.getElementById('todayBtn').addEventListener('click', () => this.selectDateByType('today'));
        document.getElementById('tomorrowBtn').addEventListener('click', () => this.selectDateByType('tomorrow'));
        document.getElementById('otherDatesBtn').addEventListener('click', () => this.selectDateByType('other'));
    }

    formatDateShort(date) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[date.getMonth()]} ${date.getDate()}`;
    }

    populateTimeOptions() {
        for (let i = 1; i <= 12; i++) {
            this.els.hourSelect.innerHTML += `<option value="${i}">${i}</option>`;
        }
        
        for (let i = 0; i < 60; i += 15) {
            this.els.minuteSelect.innerHTML += `<option value="${i}">${i.toString().padStart(2, '0')}</option>`;
        }
        
        ['hourSelect', 'minuteSelect', 'ampmSelect'].forEach(id => {
            this.els[id]?.addEventListener('change', () => this.updateDateTime());
        });
    }

    setDefaultDateTime() {
        const now = new Date();
        let hours = now.getHours();
        let minutes = Math.ceil(now.getMinutes() / 15) * 15;
        
        if (minutes === 60) {
            minutes = 0;
            hours += 1;
        }
        
        const ampm = hours >= 12 ? 'PM' : 'AM';
        let displayHours = hours;
        
        if (hours > 12) displayHours -= 12;
        if (hours === 0) displayHours = 12;
        
        this.els.hourSelect.value = displayHours;
        this.els.minuteSelect.value = minutes;
        this.els.ampmSelect.value = ampm;
        
        this.state.dateTime.date = now;
        this.updateDateTime();
    }

    selectDateByType(type) {
        document.querySelectorAll('.date-btn').forEach(btn => btn.classList.remove('active'));
        
        this.els.calendarContainer.classList.remove('visible');
        
        if (type === 'today') {
            const todayBtn = document.getElementById('todayBtn');
            todayBtn.classList.add('active');
            this.state.dateTime.date = new Date(todayBtn.dataset.date);
            this.updateDateTime();
        } else if (type === 'tomorrow') {
            const tomorrowBtn = document.getElementById('tomorrowBtn');
            tomorrowBtn.classList.add('active');
            this.state.dateTime.date = new Date(tomorrowBtn.dataset.date);
            this.updateDateTime();
        } else if (type === 'other') {
            document.getElementById('otherDatesBtn').classList.add('active');
            this.els.calendarContainer.classList.add('visible');
            this.initializeCalendar();
            return;
        }
    }

    initializeCalendar() {
        this.calendarState = {
            viewMonth: this.state.dateTime.date.getMonth(),
            viewYear: this.state.dateTime.date.getFullYear(),
            selectedDate: this.state.dateTime.date
        };
        
        this.renderCalendar();
        
        // Remove existing listeners to prevent duplicates
        const prevBtn = this.els.prevMonthBtn;
        const nextBtn = this.els.nextMonthBtn;
        
        // Clone nodes to remove all event listeners
        const newPrevBtn = prevBtn.cloneNode(true);
        const newNextBtn = nextBtn.cloneNode(true);
        
        prevBtn.parentNode.replaceChild(newPrevBtn, prevBtn);
        nextBtn.parentNode.replaceChild(newNextBtn, nextBtn);
        
        // Update element references
        this.els.prevMonthBtn = newPrevBtn;
        this.els.nextMonthBtn = newNextBtn;
        
        // Add new listeners
        this.els.prevMonthBtn.addEventListener('click', () => this.navigateMonth(-1));
        this.els.nextMonthBtn.addEventListener('click', () => this.navigateMonth(1));
    }

    navigateMonth(delta) {
        this.calendarState.viewMonth += delta;
        
        if (this.calendarState.viewMonth > 11) {
            this.calendarState.viewMonth = 0;
            this.calendarState.viewYear++;
        } else if (this.calendarState.viewMonth < 0) {
            this.calendarState.viewMonth = 11;
            this.calendarState.viewYear--;
        }
        
        this.renderCalendar();
    }

    renderCalendar() {
        const { viewMonth, viewYear, selectedDate } = this.calendarState;
        
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                      'July', 'August', 'September', 'October', 'November', 'December'];
        this.els.calendarMonthYear.textContent = `${months[viewMonth]} ${viewYear}`;
        
        const firstDay = new Date(viewYear, viewMonth, 1).getDay();
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        let calendarHTML = '';
        
        const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
        days.forEach(day => {
            calendarHTML += `<div class="calendar-day-header">${day}</div>`;
        });
        
        for (let i = 0; i < firstDay; i++) {
            calendarHTML += '<div></div>';
        }
        
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(viewYear, viewMonth, day);
            date.setHours(0, 0, 0, 0);
            
            const isPast = date < today;
            const isToday = date.getTime() === today.getTime();
            const isSelected = date.getDate() === selectedDate.getDate() && 
                   date.getMonth() === selectedDate.getMonth() && 
                   date.getFullYear() === selectedDate.getFullYear();

            const classes = [
                'calendar-day',
                isPast ? 'disabled' : '',
                isToday ? 'today' : '',
                isSelected ? 'selected' : ''
            ].filter(Boolean).join(' ');
            
            calendarHTML += `
                <button 
                    class="${classes}" 
                    data-date="${date.toISOString()}"
                    ${isPast ? 'disabled' : ''}
                >${day}</button>
            `;
        }
        
        this.els.calendarGrid.innerHTML = calendarHTML;
        
        this.els.calendarGrid.querySelectorAll('.calendar-day:not(.disabled)').forEach(dayEl => {
            dayEl.addEventListener('click', () => this.selectCalendarDate(dayEl));
        });
    }

    selectCalendarDate(dayEl) {
        const selectedDate = new Date(dayEl.dataset.date);
        this.calendarState.selectedDate = selectedDate;
        
        this.state.dateTime.date = selectedDate;
        
        this.els.calendarContainer.classList.remove('visible');
        
        document.querySelectorAll('.date-btn').forEach(btn => btn.classList.remove('active'));
        this.els.otherDatesBtn.classList.add('active');
        
        const dateValue = this.els.otherDatesBtn.querySelector('.date-value');
        dateValue.textContent = this.formatDateShort(selectedDate);
        
        this.els.otherDatesBtn.dataset.date = selectedDate.toISOString();
        
        this.updateDateTime();
    }

    updateDateTime() {
        const hours = parseInt(this.els.hourSelect.value);
        const minutes = parseInt(this.els.minuteSelect.value);
        const ampm = this.els.ampmSelect.value;
        
        const date = new Date(this.state.dateTime.date);
        let hour24 = hours;
        
        if (ampm === 'PM' && hours !== 12) hour24 += 12;
        if (ampm === 'AM' && hours === 12) hour24 = 0;
        
        date.setHours(hour24, minutes, 0, 0);
        
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        
        if (isToday && date < now) {
            this.showTimeWarning();
            
            const minTime = new Date(now.getTime() + 30 * 60000);
            const roundedMinutes = Math.ceil(minTime.getMinutes() / 15) * 15;
            minTime.setMinutes(roundedMinutes);
            
            let minHours = minTime.getHours();
            const minAmPm = minHours >= 12 ? 'PM' : 'AM';
            if (minHours > 12) minHours -= 12;
            if (minHours === 0) minHours = 12;
            
            this.els.hourSelect.value = minHours;
            this.els.minuteSelect.value = minTime.getMinutes();
            this.els.ampmSelect.value = minAmPm;
            
            date.setHours(minTime.getHours(), minTime.getMinutes(), 0, 0);
        } else {
            this.hideTimeWarning();
        }
        
        this.state.dateTime.time = date;
        
        // Call callbacks
        if (this.callbacks.onDateTimeUpdate) {
            this.callbacks.onDateTimeUpdate();
        }
    }

    showTimeWarning() {
        let warning = document.getElementById('timeWarning');
        if (!warning) {
            warning = document.createElement('div');
            warning.id = 'timeWarning';
            warning.className = 'time-warning';
            warning.innerHTML = `
                <span class="warning-icon">⚠️</span>
                <span>Please select a time at least 30 minutes from now</span>
            `;
            this.els.timeNote.parentElement.insertBefore(warning, this.els.timeNote);
        }
        warning.classList.add('visible');
    }

    hideTimeWarning() {
        const warning = document.getElementById('timeWarning');
        if (warning) {
            warning.classList.remove('visible');
        }
    }

    // Utility method to format time for display
    formatTime(date) {
        return date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    }

    // Get current selected date/time
    getSelectedDateTime() {
        return this.state.dateTime.time;
    }
}

// Export for CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DateTimeManager };
}